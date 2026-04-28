import { NextResponse } from 'next/server';
// Use default export from OpenAI SDK
import OpenAI from 'openai';
// import prisma from '@/lib/prisma'; // optional DB client if available

// POST /api/regen-image
export const runtime = 'edge';
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { storyId, pageIndex, originalPrompt, feedback } = body;
  if (!storyId || typeof pageIndex !== 'number' || !originalPrompt) {
    return NextResponse.json({ ok: false, error: 'Invalid parameters' }, { status: 400 });
  }
  // TODO: check user's Stripe subscription for access
  // const user = await getUserFromSession(request);
  // if (!user.isPremium) return NextResponse.json({ ok: false, error: 'premium_required' }, { status: 402 });
  // Build new prompt
  const prompt = feedback
    ? `${originalPrompt}. Adjust this: ${feedback}`
    : originalPrompt;
  // Call DALL·E via OpenAI
  try {
    const openai = new OpenAI();
    const response = await openai.images.generate({
      prompt,
      n: 1,
      size: '1024x1024',
    });
    const url = response.data[0]?.url;
    if (!url) throw new Error('No image returned');
    return NextResponse.json({ ok: true, imageUrl: url });
  } catch (error) {
    console.error('Image generation error', error);
    return NextResponse.json({ ok: false, error: 'generation_failed' }, { status: 500 });
  }
}
