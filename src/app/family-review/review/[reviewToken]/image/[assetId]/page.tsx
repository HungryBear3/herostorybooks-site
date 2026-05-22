import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import type { Direction, SampleAsset } from '@/lib/family-review/store';
import { findByReviewToken } from '@/lib/family-review/store';
import { sampleBriefLabelForDirection } from '@/lib/family-review/sample-briefs';
import {
  isWellFormedAssetId,
  isWellFormedReviewToken,
} from '@/lib/family-review/tokens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Sample image · HeroStoryBooks',
  robots: { index: false, follow: false },
};

function sampleProxyUrl(reviewToken: string, assetId: string): string {
  return `/api/family-review/review/${encodeURIComponent(reviewToken)}/sample/${encodeURIComponent(assetId)}`;
}

function sampleLabel(sample: SampleAsset, direction: Direction): string {
  if (
    direction !== 'dinosaur' &&
    sample.briefId === 'dinosaur-adventure' &&
    /dinosaur|t-rex|prehistoric/i.test(sample.note ?? '')
  ) {
    return 'Dinosaur adventure page';
  }
  return sampleBriefLabelForDirection(sample.briefId, direction);
}

export default async function SampleImagePage({
  params,
}: {
  params: Promise<{ reviewToken: string; assetId: string }>;
}) {
  const { reviewToken, assetId } = await params;

  if (!isWellFormedReviewToken(reviewToken) || !isWellFormedAssetId(assetId)) {
    notFound();
  }

  const submission = await findByReviewToken(reviewToken);
  const sample = submission?.samples.find((s) => s.assetId === assetId);
  if (!submission || !sample) {
    notFound();
  }

  const childName = submission.child.firstName;
  const label = sampleLabel(sample, submission.direction);
  const imageUrl = sampleProxyUrl(reviewToken, assetId);

  return (
    <main
      style={{
        minHeight: '100svh',
        background: '#f7f1e3',
        color: '#241f19',
        padding: '16px',
      }}
    >
      <div
        style={{
          maxWidth: 900,
          margin: '0 auto',
          display: 'grid',
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-sans, system-ui, sans-serif)',
            fontSize: 14,
            lineHeight: 1.4,
            color: '#695f54',
          }}
        >
          Press and hold the image, then choose Save to Photos or Download image.
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={`${childName}'s ${label}`}
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            borderRadius: 8,
            border: '1px solid rgba(36, 31, 25, 0.16)',
            background: '#efe6d4',
          }}
        />
      </div>
    </main>
  );
}
