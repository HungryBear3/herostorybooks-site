'use strict';

// QA-only preload. Intercept Next's request for @next/env before its loader can
// inspect any repository .env file. The package exposes loadEnvConfig through a
// non-configurable accessor, so return an isolated facade rather than mutating
// the package export.
const Module = require('node:module');
const originalLoad = Module._load;
const originalResolveFilename = Module._resolveFilename;
const nextEnvPath = require.resolve('@next/env');
const realNextEnv = require('@next/env');

const disabledLoadEnvConfig = () => ({
  combinedEnv: { ...process.env },
  parsedEnv: undefined,
  loadedEnvFiles: [],
});
const qaNextEnv = Object.freeze({
  ...realNextEnv,
  loadEnvConfig: disabledLoadEnvConfig,
});

Module._load = function hermeticNextEnvLoad(request, parent, isMain) {
  let targetsNextEnv = request === '@next/env';
  if (!targetsNextEnv) {
    try {
      targetsNextEnv = originalResolveFilename.call(Module, request, parent, isMain) === nextEnvPath;
    } catch {
      // Preserve the original loader's resolution error and behavior.
    }
  }
  if (targetsNextEnv) return qaNextEnv;
  return originalLoad.call(this, request, parent, isMain);
};
