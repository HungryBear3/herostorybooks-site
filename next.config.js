const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin Turbopack's tracing root to this project. Without this, Next.js
  // infers a wider workspace root (because of multiple lockfiles in parent
  // dirs) and Turbopack's NFT scope balloons. On Vercel this caused
  // "whole project traced unintentionally" warnings and post-build deploy
  // upload failures.
  turbopack: {
    root: __dirname,
  },
  // Mirror for the (legacy) outputFileTracingRoot used by Webpack pipelines —
  // harmless when Turbopack is the active builder.
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
