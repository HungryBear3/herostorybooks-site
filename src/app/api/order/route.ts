import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import {
  createOrderRecord,
  isPrintFormat,
  OrderPersistenceError,
  persistOrder,
  uploadOrderPhoto,
} from '@/lib/orders';
import { markRecoveryLeadConverted } from '@/lib/recovery';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(key);
}

function getBaseUrl() {
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const childName = String(form.get('childName') || '').trim();
    const email = String(form.get('email') || '').trim();
    const bookFormat = String(form.get('bookFormat') || 'classic').trim();

    if (!childName || !email || !isValidEmail(email)) {
      return NextResponse.json(
        { error: 'Child name and a valid email are required.' },
        { status: 400 },
      );
    }

    const draftOrder = createOrderRecord({
      childName,
      childAge: String(form.get('childAge') || ''),
      theme: String(form.get('theme') || ''),
      lesson: String(form.get('lesson') || ''),
      occasion: String(form.get('occasion') || ''),
      giftMessage: String(form.get('giftMessage') || ''),
      characterNotes: String(form.get('characterNotes') || ''),
      appearanceOptions: String(form.get('appearanceOptions') || ''),
      bookFormat,
      email,
      photoFileName: form.get('photo') instanceof File ? (form.get('photo') as File).name : null,
    });

    const photo = form.get('photo');
    let photoBlobPath = null;
    if (photo instanceof File && photo.size > 0) {
      try {
        photoBlobPath = await uploadOrderPhoto(draftOrder.id, photo);
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
      }
    }

    // Persist the order record durably. If this throws OrderPersistenceError
    // we MUST NOT create a Stripe Checkout Session — the customer would pay
    // for an order the webhook + status page can never find.
    let order;
    try {
      order = await persistOrder({ ...draftOrder, photoBlobPath });
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
    const baseUrl = getBaseUrl();
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
