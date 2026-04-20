import { NextResponse } from 'next/server';

import { upsertRecoveryLead } from '@/lib/recovery';

function isValidEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body?.email ?? '').trim().toLowerCase();

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
    }

    const lead = await upsertRecoveryLead({
      email,
      childName: body.childName ? String(body.childName) : undefined,
      bookFormat: body.bookFormat ? String(body.bookFormat) : undefined,
      theme: body.theme ? String(body.theme) : undefined,
      captureSource: 'checkout_form',
    });

    return NextResponse.json({ ok: true, leadId: lead.id });
  } catch (error) {
    console.error('Recovery capture error:', error);
    return NextResponse.json({ error: 'Recovery capture failed' }, { status: 500 });
  }
}
