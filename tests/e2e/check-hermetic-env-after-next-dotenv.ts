import config from '../../playwright.config.ts';

const resolved = config as unknown as {
  webServer: { env: Record<string, string> };
};

// Model Playwright's effective child environment: parent first, configured
// webServer overrides second.
const effective = { ...process.env, ...resolved.webServer.env };
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, effective);

const before = { ...process.env };
// Import only after installing the exact child environment. @next/env captures
// its initial environment at module load, just as it does in the real server.
const nextEnv = (await import('@next/env')).default;
const { loadEnvConfig } = nextEnv;
const loaded = loadEnvConfig(process.cwd(), false, {
  info() {},
  error() {},
}, true);

const declaredNames = new Set(
  loaded.loadedEnvFiles.flatMap((file) => Object.keys(file.env)),
);
const changedNames = [...declaredNames]
  .filter((name) => process.env[name] !== before[name])
  .sort();

// Never print values: this helper is safe even when a developer has a live
// credential-bearing .env.local file.
process.stdout.write(JSON.stringify(changedNames));
