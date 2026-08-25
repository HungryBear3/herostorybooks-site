/**
 * Mounts the homepage JSON-LD.
 *
 * The payload itself is built and escaped in src/lib/public-structured-data.ts
 * so it can be asserted directly by tests/public-structured-data.test.ts
 * without rendering React. This file is only the <script> tag.
 */
import { buildPublicStructuredData, serializeJsonLd } from '@/lib/public-structured-data';

export function PublicStructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildPublicStructuredData()) }}
    />
  );
}
