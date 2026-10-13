// Narrow stand-in for next/headers outside a Next request context: the real
// Next RequestCookies parser over a test-supplied Cookie header.
import cookieModule from 'next/dist/compiled/@edge-runtime/cookies/index.js';

let header = '';

export function setCookieHeader(value) {
  header = value;
}

export async function cookies() {
  return new cookieModule.RequestCookies(new Headers({ cookie: header }));
}
