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
      'node_modules/@types/**',
      'node_modules/typescript/**',
      'node_modules/.cache/**',
    ],
  },
  // pdfkit ships its font/data files (Helvetica.afm etc.) under
  // node_modules/pdfkit/js/data and reads them at runtime via fs. NFT cannot
  // statically detect those file accesses, so the .afm files were excluded
  // from the function bundle on Vercel and `_buildPdf` failed with:
  //   ENOENT: no such file or directory, open
  //   '/ROOT/node_modules/pdfkit/js/data/Helvetica.afm'
  // Explicitly include the entire pdfkit/js/data directory in every API
  // route bundle so PDF generation can find its fonts at runtime.
  outputFileTracingIncludes: {
    '/api/**': [
      'node_modules/pdfkit/js/data/**',
    ],
  },
};

module.exports = nextConfig;
