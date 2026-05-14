import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import {
  createOrderRecord,
  isPrintFormat,
  MAX_VOICE_BYTES,
  OrderPersistenceError,
  persistOrder,
  uploadOrderPhoto,
  uploadOrderVoice,
} from '@/lib/orders';
import {
  missingFieldErrorCode,
  missingRequiredField,
} from '@/lib/checkout-flow';
import { markRecoveryLeadConverted } from '@/lib/recovery';
import { CHECKOUT_PAUSED_CODE, CHECKOUT_PAUSED_MESSAGE, isCheckoutPaused } from '@/lib/checkout-pause';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getStripe() {
  return new Stripe(getRequiredStripeSecretKey());
}

const VOICE_EXT_RE = /\.(webm|m4a|mp3|wav|ogg|oga|aac|flac|mp4)$/i;

function isAcceptedVoiceFile(file: File): boolean {
  if (file.type && file.type.startsWith('audio/')) return true;
  if (file.name && VOICE_EXT_RE.test(file.name)) return true;
  return false;
}

function getReturnBaseUrl(request: Request): string {
  // Production: pin Stripe success/cancel URLs to the canonical brand domain.
  // We deliberately do NOT use the inbound origin in production because
  // production may be served from herostorybooks.com or from a Vercel domain,
  // and we always want the customer to land on the branded URL.
  if (process.env.VERCEL_ENV === 'production') {
    const explicit = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '');
    if (explicit) return explicit;
    return 'https://herostorybooks.com';
  }
  // Preview / development: derive base URL from the inbound request origin
  // so Stripe returns the customer to the EXACT deployment that created the
  // Checkout Session — not a stale shared preview alias that may serve older
  // code. NEXT_PUBLIC_URL is the alias and would pin previews to whichever
  // deployment that alias currently points at, which can be older than the
  // deployment that handled this POST.
  try {
    const origin = new URL(request.url).origin;
    if (origin) return origin;
  } catch {
    // fall through to env / localhost
  }
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

export async function POST(request: Request) {
  try {
    if (isCheckoutPaused()) {
      return NextResponse.json(
        {
          error: CHECKOUT_PAUSED_MESSAGE,
          code: CHECKOUT_PAUSED_CODE,
        },
        { status: 503 },
      );
    }

    const form = await request.formData();
    const childName = String(form.get('childName') || '').trim();
    const email = String(form.get('email') || '').trim();
    const bookFormat = String(form.get('bookFormat') || 'classic').trim();
    const theme = String(form.get('theme') || '').trim();
    const childPronouns = String(form.get('childPronouns') || '').trim();

    // Structured appearance fields ride along inside the JSON
    // appearanceOptions blob from the form (kept as-is for backward
    // compatibility) AND as discrete top-level fields. The launch spec
    // says skinTone + hairStyle MUST be explicit (no "Prefer AI to
    // decide"). We accept either shape so the server is robust to
    // future client refactors but enforce the same minimum.
    const appearanceRaw = String(form.get('appearanceOptions') || '');
    let appearance: { skinTone?: string; hairStyle?: string } = {};
    if (appearanceRaw) {
      try { appearance = JSON.parse(appearanceRaw) as typeof appearance; }
      catch { appearance = {}; }
    }
    const skinTone = String(form.get('skinTone') || appearance.skinTone || '').trim();
    const hairStyle = String(form.get('hairStyle') || appearance.hairStyle || '').trim();

    const voiceRaw = form.get('voice');
    const hasVoiceUpload = voiceRaw instanceof File && voiceRaw.size > 0;
    const voiceConsentRaw = String(form.get('voiceConsent') || '').trim().toLowerCase();
    const voiceConsentGiven = voiceConsentRaw === 'true' || voiceConsentRaw === 'on' || voiceConsentRaw === '1';
    const voiceSourceRaw = String(form.get('voiceSource') || '').trim();
    const voiceSource: 'recorded' | 'uploaded' | null =
      voiceSourceRaw === 'recorded' || voiceSourceRaw === 'uploaded' ? voiceSourceRaw : null;

    if (hasVoiceUpload) {
      if (!voiceConsentGiven) {
        return NextResponse.json(
          {
            error: 'Parent/guardian consent is required to attach a voice recording.',
            code: 'voice_consent_required',
          },
          { status: 400 },
        );
      }

      const voiceFile = voiceRaw as File;
      if (!isAcceptedVoiceFile(voiceFile)) {
        return NextResponse.json(
          { error: 'Voice attachment must be an audio file.', code: 'voice_invalid_type' },
          { status: 400 },
        );
      }

      if (voiceFile.size > MAX_VOICE_BYTES) {
        return NextResponse.json(
          { error: 'Voice attachment is too large (max 15 MB).', code: 'voice_too_large' },
          { status: 400 },
        );
      }
    }

    const missing = missingRequiredField({ theme, childName, email, skinTone, hairStyle, childPronouns });
    if (missing !== null || !isValidEmail(email)) {
      const code = missing ? missingFieldErrorCode(missing) : 'email_invalid';
      return NextResponse.json(
        {
          error:
            code === 'email_invalid'
              ? 'A valid email is required.'
              : `Missing required field: ${code}`,
          code,
        },
        { status: 400 },
      );
    }

    const draftOrder = createOrderRecord({
      childName,
      childAge: String(form.get('childAge') || ''),
      theme,
      lesson: String(form.get('lesson') || ''),
      occasion: String(form.get('occasion') || ''),
      giftMessage: String(form.get('giftMessage') || ''),
      characterNotes: String(form.get('characterNotes') || ''),
      childPronouns: childPronouns === 'he/him' || childPronouns === 'she/her' || childPronouns === 'they/them' ? childPronouns as 'he/him' | 'she/her' | 'they/them' : '',
      appearanceOptions: appearanceRaw,
      bookFormat,
      email,
      photoFileName: form.get('photo') instanceof File ? (form.get('photo') as File).name : null,
      voiceFileName: hasVoiceUpload ? (voiceRaw as File).name : null,
    });

    const photo = form.get('photo');
    let photoBlobPath: string | null = null;
    let photoBlobUrl: string | null = null;
    if (photo instanceof File && photo.size > 0) {
      try {
        const uploaded = await uploadOrderPhoto(draftOrder.id, photo);
        if (uploaded) {
          photoBlobPath = uploaded.pathname;
          photoBlobUrl = uploaded.url;
        }
      } catch (error) {
        // In production, OrderPersistenceError from photo upload must abort
        // BEFORE the Stripe Checkout Session — otherwise the customer pays
        // for an order whose photo is missing from durable storage.
        if (error instanceof OrderPersistenceError) {
          console.error(
            `[order] ABORT BEFORE STRIPE: photo persistence failed for ${draftOrder.id}: ${error.message}`,
            error.cause,
          );
          return NextResponse.json(
            { error: 'We could not securely save your photo. Please retry — no charge was made.' },
            { status: 503 },
          );
        }
        console.error(`[order] photo upload failed for ${draftOrder.id}; continuing without photo`, error);
        photoBlobPath = null;
        photoBlobUrl = null;
      }
    }

    let voiceBlobPath: string | null = null;
    let voiceBlobUrl: string | null = null;
    let voiceConsentAt: string | null = null;
    if (hasVoiceUpload) {
      try {
        const uploadedVoice = await uploadOrderVoice(draftOrder.id, voiceRaw as File);
        if (uploadedVoice) {
          voiceBlobPath = uploadedVoice.pathname;
          voiceBlobUrl = uploadedVoice.url;
          voiceConsentAt = new Date().toISOString();
        }
      } catch (error) {
        // Match the photo path: an OrderPersistenceError on voice persistence
        // must abort BEFORE Stripe, so no customer pays for an order whose
        // consented audio note was dropped.
        if (error instanceof OrderPersistenceError) {
          console.error(
            `[order] ABORT BEFORE STRIPE: voice persistence failed for ${draftOrder.id}: ${error.message}`,
            error.cause,
          );
          return NextResponse.json(
            { error: 'We could not securely save your voice recording. Please retry — no charge was made.' },
            { status: 503 },
          );
        }
        console.error(`[order] voice upload failed for ${draftOrder.id}; aborting`, error);
        return NextResponse.json(
          { error: 'We could not securely save your voice recording. Please retry — no charge was made.' },
          { status: 503 },
        );
      }
    }

    // Persist the order record durably. If this throws OrderPersistenceError
    // we MUST NOT create a Stripe Checkout Session — the customer would pay
    // for an order the webhook + status page can never find.
    let order;
    try {
      order = await persistOrder({
        ...draftOrder,
        photoBlobPath,
        photoBlobUrl,
        voiceBlobPath,
        voiceBlobUrl,
        voiceConsentAt,
        voiceSource: hasVoiceUpload ? voiceSource : null,
      });
    } catch (error) {
      if (error instanceof OrderPersistenceError) {
        console.error(
          `[order] ABORT BEFORE STRIPE: durable order persistence failed for ${draftOrder.id}: ${error.message}`,
          error.cause,
        );
        return NextResponse.json(
          {
            error:
              'We could not securely save your order. No charge was made. Please retry in a moment, and contact support@herostorybooks.com if it keeps happening.',
          },
          { status: 503 },
        );
      }
      throw error;
    }

    markRecoveryLeadConverted(order.email, order.id).catch(() => {});

    const stripe = getStripe();
    const baseUrl = getReturnBaseUrl(request);
    const successParams = new URLSearchParams({
      orderId: order.id,
      childName: order.childName,
      format: order.formatLabel,
      email: order.email,
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: order.email,
      client_reference_id: order.id,
      metadata: { orderId: order.id },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: order.priceCents,
            product_data: {
              name: `${order.formatLabel} HeroStoryBook — ${order.childName}`,
              description: order.deliveryExpectation,
            },
          },
          quantity: 1,
        },
      ],
      ...(isPrintFormat(order.bookFormat)
        ? { shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'] } }
        : {}),
      success_url: `${baseUrl}/thank-you?${successParams.toString()}`,
      cancel_url: `${baseUrl}/checkout`,
    });

    return NextResponse.json({ ok: true, redirectTo: session.url });
  } catch (error) {
    console.error('Order error:', error);
    return NextResponse.json({ error: 'Order submission failed' }, { status: 500 });
  }
}
