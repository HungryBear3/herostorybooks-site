import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, put } from '@vercel/blob';

export type OrderStatus = 'order_received' | 'preview_ready' | 'print_in_production' | 'shipped';
export type BookFormat = 'digital' | 'classic' | 'premium';

export interface OrderInput {
  childName: string;
  childAge?: string;
  theme?: string;
  lesson?: string;
  occasion?: string;
  giftMessage?: string;
  characterNotes?: string;
  appearanceOptions?: string;
  bookFormat: string;
  email: string;
  photoFileName?: string | null;
  photoBlobPath?: string | null;
}

export interface OrderRecord extends OrderInput {
  id: string;
  bookFormat: BookFormat;
  formatLabel: string;
  priceCents: number;
  status: OrderStatus;
  deliveryExpectation: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateOrderOptions {
  now?: string;
  id?: string;
}

const FORMAT_META: Record<BookFormat, { label: string; priceCents: number }> = {
  digital: { label: 'Digital', priceCents: 2999 },
  classic: { label: 'Classic', priceCents: 4999 },
  premium: { label: 'Premium', priceCents: 7999 },
};

const PRIVATE_BLOB_ACCESS = 'private' as const;

function normalizeFormat(bookFormat: string): BookFormat {
  if (bookFormat === 'digital' || bookFormat === 'classic' || bookFormat === 'premium') {
    return bookFormat;
  }

  if (bookFormat === 'printed') {
    return 'classic';
  }

  if (bookFormat === 'bundle') {
    return 'premium';
  }

  return 'classic';
}

export function buildDeliveryExpectation(bookFormat: string): string {
  const format = normalizeFormat(bookFormat);

  if (format === 'digital') {
    return 'PDF by email in ~15 minutes';
  }

  if (format === 'premium') {
    return 'Hardcover ships in 5–7 business days. Digital preview arrives first so you can approve before it prints.';
  }

  return 'Softcover ships in 5–7 business days. Digital preview arrives first so you can approve before it prints.';
}

export function createOrderRecord(input: OrderInput, options: CreateOrderOptions = {}): OrderRecord {
  const format = normalizeFormat(input.bookFormat);
  const meta = FORMAT_META[format];
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    childName: input.childName.trim(),
    childAge: input.childAge?.trim() || '',
    theme: input.theme?.trim() || '',
    lesson: input.lesson?.trim() || '',
    occasion: input.occasion?.trim() || '',
    giftMessage: input.giftMessage?.trim() || '',
    characterNotes: input.characterNotes?.trim() || '',
    appearanceOptions: input.appearanceOptions?.trim() || '',
    bookFormat: format,
    formatLabel: meta.label,
    priceCents: meta.priceCents,
    email: input.email.trim().toLowerCase(),
    photoFileName: input.photoFileName?.trim() || null,
    photoBlobPath: input.photoBlobPath?.trim() || null,
    status: 'order_received',
    deliveryExpectation: buildDeliveryExpectation(format),
    createdAt: now,
    updatedAt: now,
  };
}

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function getOrderStoreDir() {
  return process.env.HSB_ORDER_STORE_DIR ?? path.join(process.cwd(), '.data', 'orders');
}

function getOrderBlobPath(orderId: string) {
  return `orders/${orderId}.json`;
}

export async function uploadOrderPhoto(orderId: string, file: File) {
  const token = getBlobToken();

  if (!token || typeof file.arrayBuffer !== 'function') {
    return null;
  }

  const safeName = (file.name || 'photo')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'photo';

  const pathname = `orders/${orderId}/photo-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const blob = await put(pathname, buffer, {
    access: PRIVATE_BLOB_ACCESS,
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: file.type || 'application/octet-stream',
    token,
  });

  return blob.pathname;
}

export async function persistOrder(order: OrderRecord) {
  const token = getBlobToken();
  const serialized = JSON.stringify(order, null, 2);

  if (token) {
    await put(getOrderBlobPath(order.id), serialized, {
      access: PRIVATE_BLOB_ACCESS,
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'application/json',
      token,
    });

    return order;
  }

  const dir = getOrderStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${order.id}.json`), `${serialized}\n`, 'utf8');
  return order;
}

export async function getOrder(orderId: string) {
  const token = getBlobToken();

  if (token) {
    const result = await get(getOrderBlobPath(orderId), {
      access: PRIVATE_BLOB_ACCESS,
      token,
      useCache: false,
    });

    if (!result || !result.stream) {
      return null;
    }

    const text = await new Response(result.stream).text();
    return JSON.parse(text) as OrderRecord;
  }

  try {
    const file = await readFile(path.join(getOrderStoreDir(), `${orderId}.json`), 'utf8');
    return JSON.parse(file) as OrderRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export function isOrderStatus(value: string): value is OrderStatus {
  return ['order_received', 'preview_ready', 'print_in_production', 'shipped'].includes(value);
}

export async function updateOrderStatus(orderId: string, status: OrderStatus) {
  const existing = await getOrder(orderId);
  if (!existing) {
    return null;
  }

  const updated: OrderRecord = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}
