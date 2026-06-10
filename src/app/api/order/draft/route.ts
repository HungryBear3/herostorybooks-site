import { NextResponse } from 'next/server';

import { evaluateCheckoutAccessGate } from '@/lib/checkout-access-gate';
import { createIntakeDraft } from '@/lib/order-intake';
import { missingFieldErrorCode, missingRequiredField } from '@/lib/checkout-flow';
import { sanitizeReferralCode } from '@/lib/referrals';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return NextResponse.json({ error: 'Draft orders must be created with JSON only.', code: 'json_required' }, { status: 415 });
    }
    const body = await request.json();
    const appearanceRaw = typeof body.appearanceOptions === 'string'
      ? body.appearanceOptions
      : JSON.stringify({ skinTone: body.skinTone ?? '', hairStyle: body.hairStyle ?? '', eyewear: body.eyewear ?? '' });
    let appearance: { skinTone?: string; hairStyle?: string } = {};
    try { appearance = JSON.parse(appearanceRaw) as typeof appearance; } catch { appearance = {}; }
    const childName = String(body.childName ?? '').trim();
    const email = String(body.email ?? '').trim();
    const theme = String(body.theme ?? '').trim();
    const skinTone = String(body.skinTone ?? appearance.skinTone ?? '').trim();
    const hairStyle = String(body.hairStyle ?? appearance.hairStyle ?? '').trim();
    const missing = missingRequiredField({ theme, childName, email, skinTone, hairStyle });
    if (missing !== null || !isValidEmail(email)) {
      const code = missing ? missingFieldErrorCode(missing) : 'email_invalid';
      return NextResponse.json(
        { error: code === 'email_invalid' ? 'A valid email is required.' : `Missing required field: ${code}`, code },
        { status: 400 },
      );
    }
    const gate = await evaluateCheckoutAccessGate(email, 'order-draft');
    if (gate.ok === false) return NextResponse.json(gate.body, { status: gate.status });

    const draft = await createIntakeDraft({
      childName,
      childAge: String(body.childAge ?? ''),
      childPronouns: String(body.childPronouns ?? ''),
      theme,
      lesson: String(body.lesson ?? ''),
      occasion: String(body.occasion ?? ''),
      giftMessage: String(body.giftMessage ?? ''),
      characterNotes: String(body.characterNotes ?? ''),
      familyCharacters: body.familyCharacters ?? null,
      appearanceOptions: appearanceRaw,
      bookFormat: String(body.bookFormat ?? 'classic'),
      email,
      referralCode: sanitizeReferralCode(body.referralCode),
    });
    return NextResponse.json({ ok: true, draftOrderId: draft.id });
  } catch (error) {
    console.error('[order-draft] failed to create draft', error);
    return NextResponse.json(
      { error: 'We could not securely save your order draft. You have not been charged.', code: 'draft_persist_failed' },
      { status: 503 },
    );
  }
}
