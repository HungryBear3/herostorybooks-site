/** Explicit operator staging; default validates locally and performs no network IO. */
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { characterImagePath } from '../src/lib/character-review.ts';
export async function inspectCharacterSheet(orderId: string, filename: string) {
 if (!/^ord_[a-zA-Z0-9_-]+$/.test(orderId)) throw Error('invalid_order_id');
 const stat = await lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw Error('invalid_png_file');
 const bytes = await readFile(filename);
 if (bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('invalid_png');
 await sharp(bytes, { limitInputPixels: 40000000 }).raw().toBuffer();
 const imageHash = createHash('sha256').update(bytes).digest('hex');
 return { bytes, imageHash, pathname: characterImagePath(orderId, imageHash) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 try {
  const [orderId, filename, flag] = process.argv.slice(2);
  if (!orderId || !filename || (flag && flag !== '--execute')) throw Error('usage: stage-character-sheet.ts ORDER_ID PNG [--execute]');
  const candidate = await inspectCharacterSheet(orderId, filename);
  if (flag === '--execute') {
   const token = process.env.HSB_PRIVATE_READ_WRITE_TOKEN?.trim();
   if (!token || token === process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw Error('distinct_private_store_credential_required');
   const { put } = await import('@vercel/blob');
   await put(candidate.pathname, candidate.bytes, { access: 'private', token, contentType: 'image/png', addRandomSuffix: false, allowOverwrite: false });
  }
  console.log(JSON.stringify({ imageHash: candidate.imageHash, pathname: candidate.pathname, staged: flag === '--execute', customerRelease: false }));
 } catch (error) { console.error(error instanceof Error ? error.message : 'staging_failed'); process.exitCode = 1; }
}
