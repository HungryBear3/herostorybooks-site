import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, list, put } from '@vercel/blob';

export type RecoveryStatus = 'active' | 'converted' | 'abandoned' | 'unsubscribed';

export interface RecoveryInput {
  email: string;
  childName?: string;
  bookFormat?: string;
  theme?: string;
  captureSource?: string;
}

export interface RecoveryLead {
  id: string;
  email: string;
  childName: string;
  bookFormat: string;
  theme: string;
  captureSource: string;
  status: RecoveryStatus;
  convertedToOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Pure helpers (testable without persistence) ───────────────────────────────

export function buildNewRecoveryLead(
  input: RecoveryInput,
  options: { id?: string; now?: string } = {},
): RecoveryLead {
  const now = options.now ?? new Date().toISOString();
  return {
    id: options.id ?? `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    email: input.email.trim().toLowerCase(),
    childName: input.childName?.trim() ?? '',
    bookFormat: input.bookFormat?.trim() ?? '',
    theme: input.theme?.trim() ?? '',
    captureSource: input.captureSource?.trim() ?? 'checkout_form',
    status: 'active',
    convertedToOrderId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Merges new input onto an existing lead. Empty incoming values never overwrite.
export function mergeRecoveryUpdate(
  existing: RecoveryLead,
  input: RecoveryInput,
  now?: string,
): RecoveryLead {
  return {
    ...existing,
    childName: input.childName?.trim() || existing.childName,
    bookFormat: input.bookFormat?.trim() || existing.bookFormat,
    theme: input.theme?.trim() || existing.theme,
    captureSource: input.captureSource?.trim() || existing.captureSource,
    updatedAt: now ?? new Date().toISOString(),
  };
}

// ── Persistence (mirrors orders.ts blob/local-file pattern) ──────────────────

const PRIVATE_BLOB_ACCESS = 'private' as const;

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function getRecoveryStoreDir() {
  return path.join(process.cwd(), '.data', 'recovery');
}

function emailHash(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

function getRecoveryBlobPath(email: string): string {
  return `recovery/${emailHash(email)}.json`;
}

async function getRecoveryLead(email: string): Promise<RecoveryLead | null> {
  const token = getBlobToken();

  if (token) {
    try {
      const result = await get(getRecoveryBlobPath(email), {
        access: PRIVATE_BLOB_ACCESS,
        token,
        useCache: false,
      });
      if (!result?.stream) return null;
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as RecoveryLead;
    } catch {
      return null;
    }
  }

  try {
    const file = await readFile(
      path.join(getRecoveryStoreDir(), `${emailHash(email)}.json`),
      'utf8',
    );
    return JSON.parse(file) as RecoveryLead;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function persistRecoveryLead(lead: RecoveryLead): Promise<void> {
  const token = getBlobToken();
  const serialized = JSON.stringify(lead, null, 2);

  if (token) {
    await put(getRecoveryBlobPath(lead.email), serialized, {
      access: PRIVATE_BLOB_ACCESS,
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'application/json',
      token,
    });
    return;
  }

  const dir = getRecoveryStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${emailHash(lead.email)}.json`), `${serialized}\n`, 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function upsertRecoveryLead(input: RecoveryInput): Promise<RecoveryLead> {
  const email = input.email?.trim();
  if (!email) throw new Error('email is required');

  const existing = await getRecoveryLead(email);
  const lead = existing
    ? mergeRecoveryUpdate(existing, input)
    : buildNewRecoveryLead(input);

  await persistRecoveryLead(lead);
  return lead;
}

// ── Sweep helpers ─────────────────────────────────────────────────────────────

const DEFAULT_ABANDON_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

export function isAbandonedCandidate(
  lead: RecoveryLead,
  now = new Date().toISOString(),
  thresholdMs = DEFAULT_ABANDON_THRESHOLD_MS,
): boolean {
  if (lead.status !== 'active') return false;
  const age = new Date(now).getTime() - new Date(lead.updatedAt).getTime();
  return age >= thresholdMs;
}

export async function listRecoveryLeads(): Promise<RecoveryLead[]> {
  const token = getBlobToken();

  if (token) {
    const { blobs } = await list({ prefix: 'recovery/', token });
    const leads: RecoveryLead[] = [];
    for (const blob of blobs) {
      try {
        const result = await get(blob.pathname, { access: PRIVATE_BLOB_ACCESS, token, useCache: false });
        if (!result?.stream) continue;
        const text = await new Response(result.stream).text();
        leads.push(JSON.parse(text) as RecoveryLead);
      } catch {
        // skip corrupt/unreadable blobs
      }
    }
    return leads;
  }

  const dir = getRecoveryStoreDir();
  try {
    const files = await readdir(dir);
    const leads: RecoveryLead[] = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const text = await readFile(path.join(dir, file), 'utf8');
        leads.push(JSON.parse(text) as RecoveryLead);
      } catch {
        // skip corrupt files
      }
    }
    return leads;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function markRecoveryLeadAbandoned(lead: RecoveryLead): Promise<void> {
  await persistRecoveryLead({
    ...lead,
    status: 'abandoned',
    updatedAt: new Date().toISOString(),
  });
}

// Call after a real order is placed. Fire-and-forget safe.
export async function markRecoveryLeadConverted(
  email: string,
  orderId: string,
): Promise<void> {
  const existing = await getRecoveryLead(email);
  if (!existing) return;

  await persistRecoveryLead({
    ...existing,
    status: 'converted',
    convertedToOrderId: orderId,
    updatedAt: new Date().toISOString(),
  });
}
