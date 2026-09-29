/**
 * A controllable browser for analytics boundary tests.
 *
 * Installs `window`/`document` globals with a real URL location, a Map-backed
 * localStorage, recording gtag and Vercel (`window.va`) sinks, and a document
 * that records — and refuses — any attempt to create or attach an element, so
 * a test can prove that no third-party script was loaded. `Date.now` is pinned
 * so serialized timestamps are literal. Everything is restored afterwards.
 */
export interface BrowserFixture {
  win: {
    location: URL;
    localStorage: Storage;
    gtag: (...args: unknown[]) => void;
    va: (...args: unknown[]) => void;
    hsbEvents?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  doc: { referrer: string; cookie: string; [key: string]: unknown };
  local: Map<string, string>;
  gtag: unknown[][];
  vercel: unknown[][];
  domWrites: string[];
}

export interface BrowserFixtureOptions {
  href: string;
  referrer?: string;
  cookie?: string;
  now: number;
  storage?: Record<string, string>;
}

function mapStorage(map: Map<string, string>): Storage {
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  };
}

export async function withBrowser<T>(
  options: BrowserFixtureOptions,
  run: (fixture: BrowserFixture) => T | Promise<T>,
): Promise<T> {
  const local = new Map(Object.entries(options.storage ?? {}));
  const gtag: unknown[][] = [];
  const vercel: unknown[][] = [];
  const domWrites: string[] = [];
  const refuse = (what: string) => () => {
    domWrites.push(what);
    throw new Error(`analytics test browser: ${what} is not allowed`);
  };
  const win: BrowserFixture['win'] = {
    location: new URL(options.href),
    localStorage: mapStorage(local),
    gtag: (...args: unknown[]) => { gtag.push(JSON.parse(JSON.stringify(args))); },
    va: (...args: unknown[]) => { vercel.push(JSON.parse(JSON.stringify(args))); },
    hsbEvents: [],
  };
  const doc: BrowserFixture['doc'] = {
    referrer: options.referrer ?? '',
    cookie: options.cookie ?? '',
    createElement: refuse('createElement'),
    write: refuse('write'),
    head: { appendChild: refuse('head.appendChild'), insertBefore: refuse('head.insertBefore') },
    body: { appendChild: refuse('body.appendChild'), insertBefore: refuse('body.insertBefore') },
  };
  const prior = { window: globalThis.window, document: globalThis.document };
  const realNow = Date.now;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Date.now = () => options.now;
  try {
    return await run({ win, doc, local, gtag, vercel, domWrites });
  } finally {
    Date.now = realNow;
    for (const key of ['window', 'document'] as const) {
      if (prior[key] === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: prior[key] });
    }
  }
}
