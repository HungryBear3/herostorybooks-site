import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { createOrderRecord } from '@/lib/orders';
import { submitPrintJob } from '@/lib/lulu';

export const dynamic = 'force-dynamic';

const SAMPLE_PACKAGE_ID = '0600X0900.BW.STD.PB.060UW444.MXX';
const SAMPLE_COVER_URL = 'https://www.dropbox.com/sh/p3zh22vzsaegiri/AADP367j0bTWlt8fCu-_tm2ia/161025/139056_cover.pdf?dl=1';
const SAMPLE_COVER_MD5 = 'e78512c777e7f5841fe8f1992cefb898';
const SAMPLE_INTERIOR_URL = 'https://www.dropbox.com/sh/p3zh22vzsaegiri/AACOUn3LFKsITDzylh13bQpsa/161025/thesis2.pdf?dl=1';
const SAMPLE_INTERIOR_MD5 = '7f8af20c296747689756f8e310135d79';

export async function POST(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const order = createOrderRecord(
      { childName: 'Lulu Sandbox', bookFormat: 'classic', email: 'support@herostorybooks.com' },
      { id: `ord_sandbox_${Date.now()}`, now: new Date().toISOString() },
    );

    order.paymentStatus = 'paid';
    order.shippingAddress = {
      line1: '123 Test Street',
      city: 'Raleigh',
      state: 'NC',
      zip: '27601',
      country: 'US',
    };
    order.printTitle = 'Sandbox API Validation';
    order.printInteriorArtifactUrl = SAMPLE_INTERIOR_URL;
    order.printInteriorMd5 = SAMPLE_INTERIOR_MD5;
    order.printInteriorPageCount = 210;
    order.printCoverArtifactUrl = SAMPLE_COVER_URL;
    order.printCoverMd5 = SAMPLE_COVER_MD5;

    const previousApiUrl = process.env.LULU_API_URL;
    process.env.LULU_API_URL = 'https://api.sandbox.lulu.com';
    const previous = process.env.LULU_SOFTCOVER_POD_PACKAGE_ID;
    process.env.LULU_SOFTCOVER_POD_PACKAGE_ID = SAMPLE_PACKAGE_ID;
    try {
      const result = await submitPrintJob(order);
      return NextResponse.json({
        ok: true,
        orderId: order.id,
        environment: process.env.VERCEL_ENV ?? 'unknown',
        luluApiUrl: process.env.LULU_API_URL ?? 'https://api.lulu.com',
        packageId: SAMPLE_PACKAGE_ID,
        job: result,
      });
    } finally {
      if (previous == null) delete process.env.LULU_SOFTCOVER_POD_PACKAGE_ID;
      else process.env.LULU_SOFTCOVER_POD_PACKAGE_ID = previous;
      if (previousApiUrl == null) delete process.env.LULU_API_URL;
      else process.env.LULU_API_URL = previousApiUrl;
    }
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        environment: process.env.VERCEL_ENV ?? 'unknown',
        luluApiUrl: process.env.LULU_API_URL ?? 'https://api.lulu.com',
      },
      { status: 500 },
    );
  }
}
