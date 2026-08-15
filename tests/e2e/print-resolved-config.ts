/**
 * Prints the RESOLVED Playwright config as JSON, so a test can re-resolve it in
 * a child process under a chosen environment.
 *
 * This is what proves the env wiring end to end. Asserting values in-process
 * only shows what the config resolved to for THIS process's environment — it
 * cannot distinguish "read through the strict resolver" from "hardcoded to the
 * same number", so a literal would pass while the CI override was dead.
 *
 * Not collected by Playwright: its testMatch takes only *.spec.ts / *.test.ts.
 */
import config from '../../playwright.config.ts';

const resolved = config as unknown as {
  use: { baseURL: string };
  webServer: { command: string; url: string; timeout: number; env: Record<string, string> };
};

process.stdout.write(JSON.stringify({
  command: resolved.webServer.command,
  url: resolved.webServer.url,
  timeout: resolved.webServer.timeout,
  baseURL: resolved.use.baseURL,
  storeDir: resolved.webServer.env.HSB_ORDER_STORE_DIR,
}));
