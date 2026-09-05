import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planStorybook } from '../src/lib/story-planner.ts';
import {
  buildPageProseUserPrompt,
  buildUserPrompt,
  generateStoryWithMeta,
  getLockedPageProse,
} from '../src/lib/story-generator.ts';
import {
  createOrderRecord,
  documentExtensionForFile,
  OrderPersistenceError,
  uploadOrderDocument,
} from '../src/lib/orders.ts';

const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const route = readFileSync('src/app/api/order/route.ts', 'utf8');
const orders = readFileSync('src/lib/orders.ts', 'utf8');
const adminOrder = readFileSync('src/app/admin/orders/[orderId]/page.tsx', 'utf8');

test('legacy checkout sends audio as voice and non-audio as document', () => {
  assert.match(checkout, /const attachedStoryFile = isCustomStorySelected \? form\.voiceFile : null/);
  assert.match(checkout, /if \(attachedStoryFile && attachedStoryFileIsAudio\)[\s\S]*?payload\.set\("voice", attachedStoryFile\)/);
  assert.match(checkout, /else if \(attachedStoryFile\)[\s\S]*?payload\.set\("document", attachedStoryFile\)/);
  assert.match(checkout, /payload\.set\("documentConsent", form\.voiceConsent \? "true" : "false"\)/);
});

test('legacy order route parses and validates document independently from voice', () => {
  assert.match(route, /const explicitDocumentRaw = form\.get\('document'\)/);
  assert.match(route, /const attachmentClassification = [\s\S]*?classifyStoryAttachment\(attachmentRaw\)/);
  assert.match(route, /const legacyDocumentInVoice = attachmentClassification\?\.kind === 'document'/);
  assert.match(route, /const documentRaw = explicitDocumentClassification[\s\S]*?legacyDocumentInVoice/);
  assert.match(route, /document_consent_required/);
  assert.match(route, /document_invalid_type/);
  assert.match(route, /document_too_large/);
  assert.match(route, /MAX_DOCUMENT_BYTES/);
});

test('legacy route rejects contradictory or duplicate attachment lanes and null voice persistence', () => {
  assert.match(route, /classifyStoryAttachment\(attachmentRaw\)/);
  assert.match(route, /attachment_type_conflict/);
  assert.match(route, /duplicate_document_attachment/);
  assert.match(route, /if \(!uploadedVoice\) \{[\s\S]*?voice_persist_failed/);
});

test('legacy order route persists dedicated document metadata before Stripe', () => {
  const uploadIndex = route.indexOf('await uploadOrderDocument');
  const persistIndex = route.indexOf('documentBlobPath,');
  // Document metadata is a legacy-path concern and must be durable before the
  // legacy provisioner can create anything payable.
  const stripeIndex = route.indexOf('await provisionCheckoutSession({');
  assert.ok(uploadIndex > -1 && uploadIndex < persistIndex && persistIndex < stripeIndex);
  assert.match(route, /if \(!uploadedDocument\) \{[\s\S]*?document_persist_failed/);
  assert.match(route, /documentBlobUrl,/);
  assert.match(route, /documentConsentAt,/);
  assert.match(route, /documentSource: hasDocumentUpload \? 'uploaded' as const : null/);
});

test('order model and storage helper keep document metadata separate from voice', () => {
  assert.match(orders, /documentBlobPath\?: string \| null/);
  assert.match(orders, /documentBlobUrl\?: string \| null/);
  assert.match(orders, /documentConsentAt\?: string \| null/);
  assert.match(orders, /export const MAX_DOCUMENT_BYTES = 10 \* 1024 \* 1024/);
  assert.match(orders, /export async function uploadOrderDocument/);
  assert.match(orders, /document-\$\{assetId\}/);
});

test('document storage rejects audio at its own trust boundary', async () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;
  const originalBlobToken = env.BLOB_READ_WRITE_TOKEN;
  try {
    env.NODE_ENV = 'development';
    delete env.BLOB_READ_WRITE_TOKEN;
    const audio = new File([new Uint8Array([1, 2, 3])], 'note.mp3', { type: 'audio/mpeg' });
    await assert.rejects(
      () => uploadOrderDocument('ord_document_boundary', audio),
      (error) => error instanceof OrderPersistenceError,
    );
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalBlobToken === undefined) delete env.BLOB_READ_WRITE_TOKEN;
    else env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
  }
});

test('admin exposes document presence, storage reference, and consent without an original filename', () => {
  assert.match(adminOrder, /hasDocumentUpload: Boolean\([\s\S]*?order\.documentBlobPath[\s\S]*?order\.documentIntakeMedia/);
  assert.match(adminOrder, /documentStoragePath:[\s\S]*?order\.documentBlobPath[\s\S]*?order\.documentIntakeMedia\?\.pathname/);
  assert.match(adminOrder, /documentConsentAt:[\s\S]*?order\.documentConsentAt[\s\S]*?order\.documentIntakeMedia\?\.consentAt/);
  assert.match(adminOrder, /label="Document upload present"/);
  assert.match(adminOrder, /label="Document storage path"/);
  assert.match(adminOrder, /label="Document consent recorded"/);
  assert.match(adminOrder, /label="Document handling"[\s\S]*?manual review only \(not parsed\)/);
  assert.doesNotMatch(adminOrder, /documentFileName/);
});

test('typed story crosses checkout, API, order storage, and admin as its own full-length lane', () => {
  assert.match(checkout, /if \(isCustomStorySelected && form\.customStoryMemory\.trim\(\)\) \{[\s\S]*?payload\.set\("customStoryText", form\.customStoryMemory\.trim\(\)\)/);
  assert.match(route, /custom_story_source_theme_mismatch/);
  assert.match(route, /theme !== ['"]custom-voice-story['"][\s\S]*?customStoryText/);
  assert.doesNotMatch(checkout, /Custom story memory \/ typed fallback/);
  assert.match(route, /const customStoryText = String\(form\.get\('customStoryText'\)[\s\S]*?slice\(0, 1200\)/);
  assert.match(route, /customStoryText,/);
  assert.match(orders, /customStoryText\?: string/);
  assert.match(adminOrder, /label="Typed story"[\s\S]*?storyInput\.customStoryText/);
  assert.doesNotMatch(adminOrder, /customStoryTextPreview/);

  const fullText = 'x'.repeat(1200);
  const order = createOrderRecord({
    childName: 'Preview Hero',
    bookFormat: 'digital',
    email: 'preview@example.test',
    customStoryText: fullText,
  });
  assert.equal(order.customStoryText, fullText);
  assert.equal(order.characterNotes, '');
  assert.match(buildUserPrompt(order), /Typed story source: x{1200}/);
  const firstBeat = planStorybook(order, 24).pages[0]!;
  assert.match(
    buildPageProseUserPrompt(order, firstBeat, 24, null),
    /CUSTOM STORY SOURCE: x{1200}/,
  );
  const lastBeat = planStorybook({ ...order, theme: 'brave-explorer' }, 24).pages[23]!;
  assert.equal(getLockedPageProse({ ...order, theme: 'brave-explorer' }, lastBeat, 24), null);
});

test('typed Custom Story refuses generic template fallback when no model path is available', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFlag = process.env.HSB_ENABLE_OPENAI_STORY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.HSB_ENABLE_OPENAI_STORY;
  try {
    const order = createOrderRecord({
      childName: 'Preview Hero',
      bookFormat: 'digital',
      email: 'preview@example.test',
      customStoryText: 'A unique typed family memory.',
    });
    await assert.rejects(
      () => generateStoryWithMeta(order),
      /template fallback is disabled for typed custom stories/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousFlag === undefined) delete process.env.HSB_ENABLE_OPENAI_STORY;
    else process.env.HSB_ENABLE_OPENAI_STORY = previousFlag;
  }
});

test('custom story intake presents distinct honest source copy', () => {
  assert.match(checkout, /Type it, say it, or attach a file\. One is enough\./);
  assert.match(checkout, /Built from your written memory, voice note, or document, plus family details\./);
  assert.match(checkout, /Your typed story, voice note, and files are read by our team and used only to write this book\./);
  assert.match(checkout, /Never used for voice cloning or AI training\./);
});

test('empty-MIME accepted documents keep the validated filename extension', () => {
  assert.equal(documentExtensionForFile(new File(['docx'], 'notes.docx', { type: '' })), 'docx');
  assert.equal(documentExtensionForFile(new File(['pdf'], 'notes.PDF', { type: '' })), 'pdf');
  assert.equal(documentExtensionForFile(new File(['txt'], 'notes.txt', { type: 'text/plain' })), 'txt');
});
