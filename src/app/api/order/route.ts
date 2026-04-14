import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const data: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        // File uploads will be handled by a storage service (e.g. S3/Cloudinary) — skipped for now
        data[key] = value.name;
      } else {
        data[key] = value as string;
      }
    }
    // TODO: persist order to database / send confirmation email
    console.log('New order received:', data);
    return NextResponse.redirect(new URL('/thank-you', request.url));
  } catch (error) {
    console.error('Order error:', error);
    return NextResponse.json({ error: 'Order submission failed' }, { status: 500 });
  }
}
