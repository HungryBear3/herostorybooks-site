/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin Turbopack's tracing root to this project. Without this, Next.js
  // infers a wider workspace root (because of multiple lockfiles in parent
  // dirs) and Turbopack's NFT scope balloons.
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
  // Exclude heavy static assets and dev/test files from EVERY serverless
  // function bundle. Without this, Next 16's NFT was copying ~10 design PNGs
  // (~6 MB total) into all 22 function bundles, plus node_modules dev
  // dependencies, pushing each function over Vercel's 250 MB uncompressed
  // limit and breaking the deploy upload step.
  //
  // public/ files are served via CDN — they never need to be in serverless
  // function bundles. tests/ and *.test.ts files are runtime-irrelevant.
  outputFileTracingExcludes: {
    '*': [
      'public/**',
      'tests/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      'docs/**',
      'scripts/**',
      'graphify-out/**',
      '.data/**',
      'tmp/**',
      'tmp_*/**',
      'node_modules/@types/**',
      'node_modules/typescript/**',
      'node_modules/.cache/**',
    ],
  },
  // pdfkit reads its built-in font/AFM metrics from node_modules/pdfkit/js/data
  // at runtime via fs. Next 16's NFT cannot statically detect those accesses,
  // and even an explicit outputFileTracingIncludes for the data files did not
  // resolve the runtime ENOENT. Marking pdfkit as a server external package
  // tells Next to leave it unbundled so it loads from node_modules at runtime,
  // where its data files are intact.
  serverExternalPackages: ['pdfkit'],
  // Belt-and-suspenders: also explicitly include the data files in every API
  // route bundle in case the external resolution still goes through tracing.
  outputFileTracingIncludes: {
    '/api/**': [
      'node_modules/pdfkit/**',
    ],
  },
  // Route-safety redirects added in the 2026-05-19 hotfix. These cover
  // short / legacy URLs that visitors and link-shares hit. All three are
  // permanent (308) because the destinations are stable.
  //   /faq    → /#faq      (FAQ anchor on the homepage)
  //   /start  → /checkout  (legacy "start your book" entry)
  //   /sample → /samples   (singular alias for the samples page)
  // Branded 404 for everything else lives at src/app/not-found.tsx.
  async redirects() {
    return [
      { source: '/faq',    destination: '/#faq',     permanent: true },
      { source: '/start',  destination: '/checkout', permanent: true },
      { source: '/sample', destination: '/samples',  permanent: true },
    ];
  },
};

module.exports = nextConfig;
