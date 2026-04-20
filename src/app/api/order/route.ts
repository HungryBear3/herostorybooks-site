import { NextResponse } from 'next/server';

import { sendOrderConfirmationEmail } from '@/lib/order-email';
import { createOrderRecord, persistOrder, uploadOrderPhoto } from '@/lib/orders';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
      bookFormat,
      email,
      photoFileName: form.get('photo') instanceof File ? (form.get('photo') as File).name : null,
    });

    const photo = form.get('photo');
    const photoBlobPath = photo instanceof File && photo.size > 0
      ? await uploadOrderPhoto(draftOrder.id, photo)
      : null;

    const order = await persistOrder({
      ...draftOrder,
      photoBlobPath,
    });

    await sendOrderConfirmationEmail(order);

    const params = new URLSearchParams({
      orderId: order.id,
      childName: order.childName,
      format: order.formatLabel,
      email: order.email,
    });

    return NextResponse.json({
      ok: true,
      orderId: order.id,
      status: order.status,
      redirectTo: `/thank-you?${params.toString()}`,
    });
  } catch (error) {
    console.error('Order error:', error);
    return NextResponse.json({ error: 'Order submission failed' }, { status: 500 });
  }
}
