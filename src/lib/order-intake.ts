import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { get, put } from '@vercel/blob';

import {
  createOrderRecord,
  OrderPersistenceError,
  persistOrder,
  requiresDurablePersistence,
  sanitizeFamilyCharacters,
  getBlobAccessMode,
  uploadOrderGuidedPhoto,
  uploadOrderPhoto,
  uploadOrderSupportingPhoto,
  uploadOrderVoice,
  withBlobNamespace,
  type FamilyCharacter,
  type FamilyCharacterReferencePhoto,
  type OrderInput,
  type OrderRecord,
  type UploadedPhotoRef,
} from './orders.ts';
import type { GuidedReferencePhotoRecord } from './guided-photo-capture.ts';
import { MAX_GUIDED_PHOTO_BYTES, MAX_GUIDED_PHOTOS, MAX_GUIDED_PHOTOS_TOTAL_BYTES, isAcceptedGuidedPhotoFile, sanitizeGuidedPhotoLabel } from './guided-photo-capture.ts';
import { MAX_VOICE_BYTES } from './orders.ts';

export type IntakeDraftStatus = 'draft' | 'assets_uploaded' | 'finalized' | 'abandoned';
export type IntakeAssetCategory =
  | 'primary_photo'
  | 'guided_child_reference'
  | 'supporting_character_reference'
  | 'voice_inspiration'
  | 'document_inspiration';

export interface IntakeAssetRef {
  assetId: string;
  category: IntakeAssetCategory;
  blobPath: string | null;
  blobUrl: string | null;
  fileName: string | null;
  mime: string | null;
  size: number;
  label?: string | null;
  familyCharacterId?: string | null;
  familyCharacterIndex?: number | null;
  source?: 'upload' | 'guided_capture' | 'recorded' | null;
  uploadedAt: string;
}

export interface IntakeDraftRecord {
  id: string;
  status: IntakeDraftStatus;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string | null;
  orderId?: string | null;
  fields: OrderInput;
  familyCharacters: FamilyCharacter[];
  assets: IntakeAssetRef[];
  consent: {
    guidedPhotoConsentAt?: string | null;
    voiceConsentAt?: string | null;
  };
}

export interface CreateDraftInput extends Omit<OrderInput, 'photoFileName' | 'photoBlobPath' | 'photoBlobUrl'> {
  familyCharacters?: OrderInput['familyCharacters'];
}

function draftStoreDir() {
  if (process.env.HSB_ORDER_DRAFT_STORE_DIR) return process.env.HSB_ORDER_DRAFT_STORE_DIR;
  if (process.env.HSB_ORDER_STORE_DIR) return `${process.env.HSB_ORDER_STORE_DIR}/../order-drafts`;
  if (process.env.VERCEL) return '/tmp/hsb/order-drafts';
  return '.data/order-drafts';
}

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function draftBlobPath(draftId: string) {
  return withBlobNamespace(`order-drafts/${draftId}.json`);
}

function newDraftId() {
  return `draft_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function newAssetId() {
  return `asset_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function isValidIntakeDraftId(draftId: string): boolean {
  return /^draft_[a-f0-9]{16}$/.test(draftId);
}

function assertValidDraftId(draftId: string): void {
  if (!isValidIntakeDraftId(draftId)) {
    const error = new OrderPersistenceError(draftId, 'Invalid draft order id');
    (error as Error & { status?: number; code?: string }).status = 400;
    (error as Error & { status?: number; code?: string }).code = 'draft_id_invalid';
    throw error;
  }
}

function cleanString(value: unknown, max = 500): string {
  return String(value ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function persistIntakeDraft(draft: IntakeDraftRecord): Promise<IntakeDraftRecord> {
  assertValidDraftId(draft.id);
  const token = getBlobToken();
  const body = JSON.stringify(draft, null, 2);
  if (token) {
    try {
      await put(draftBlobPath(draft.id), body, {
        access: getBlobAccessMode(),
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token,
      });
      return draft;
    } catch (error) {
      if (requiresDurablePersistence()) {
        throw new OrderPersistenceError(draft.id, 'Durable draft persistence failed', error);
      }
    }
  } else if (requiresDurablePersistence()) {
    throw new OrderPersistenceError(draft.id, 'BLOB_READ_WRITE_TOKEN missing — cannot persist draft order');
  }
  const dir = draftStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${draft.id}.json`), `${body}\n`, 'utf8');
  return draft;
}

export async function getIntakeDraft(draftId: string): Promise<IntakeDraftRecord | null> {
  assertValidDraftId(draftId);
  const token = getBlobToken();
  if (token) {
    try {
      const result = await get(draftBlobPath(draftId), { access: getBlobAccessMode(), token, useCache: false });
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as IntakeDraftRecord;
    } catch (error) {
      if (requiresDurablePersistence()) throw new OrderPersistenceError(draftId, 'Durable draft read failed', error);
    }
  } else if (requiresDurablePersistence()) {
    throw new OrderPersistenceError(draftId, 'BLOB_READ_WRITE_TOKEN missing — cannot read draft order');
  }
  try {
    const text = await readFile(path.join(draftStoreDir(), `${draftId}.json`), 'utf8');
    return JSON.parse(text) as IntakeDraftRecord;
  } catch {
    return null;
  }
}

export async function createIntakeDraft(input: CreateDraftInput, now = new Date().toISOString()) {
  const fields: OrderInput = {
    childName: cleanString(input.childName, 120),
    childAge: cleanString(input.childAge, 40),
    childPronouns: input.childPronouns ?? '',
    theme: cleanString(input.theme, 120),
    lesson: cleanString(input.lesson, 120),
    occasion: cleanString(input.occasion, 120),
    giftMessage: cleanString(input.giftMessage, 500),
    characterNotes: cleanString(input.characterNotes, 800),
    familyCharacters: input.familyCharacters ?? null,
    appearanceOptions: typeof input.appearanceOptions === 'string' ? input.appearanceOptions : '',
    bookFormat: cleanString(input.bookFormat || 'classic', 40),
    email: cleanString(input.email, 200),
    referralCode: input.referralCode ?? null,
    voiceSource: input.voiceSource ?? null,
  };
  const familyCharacters = sanitizeFamilyCharacters(fields.familyCharacters);
  const draft: IntakeDraftRecord = {
    id: newDraftId(),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    fields,
    familyCharacters,
    assets: [],
    consent: {},
  };
  await persistIntakeDraft(draft);
  return draft;
}

function isAudio(file: File) {
  return (file.type || '').startsWith('audio/') || /\.(webm|m4a|mp3|wav|ogg|oga|aac|caf|aif|aiff|flac|mp4)$/i.test(file.name || '');
}

function isAcceptedDoc(file: File) {
  return ['text/plain', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.type) || /\.(txt|pdf|doc|docx)$/i.test(file.name || '');
}

export function validateIntakeAssetFile(category: IntakeAssetCategory, file: File): { ok: true } | { ok: false; status: number; code: string; error: string } {
  if (!(file instanceof File) || file.size <= 0) return { ok: false, status: 400, code: 'asset_missing', error: 'Missing upload file. You have not been charged.' };
  if (category === 'primary_photo' || category === 'supporting_character_reference' || category === 'guided_child_reference') {
    if (!isAcceptedGuidedPhotoFile(file)) return { ok: false, status: 400, code: 'asset_invalid_type', error: 'Reference photos must be still images (JPEG, PNG, WebP, or HEIC) — never video. You have not been charged.' };
    if (file.size > MAX_GUIDED_PHOTO_BYTES) return { ok: false, status: 413, code: 'asset_too_large', error: 'That reference photo is too large. Please use a smaller still photo and try again — you have not been charged.' };
    return { ok: true };
  }
  if (category === 'voice_inspiration') {
    if (!isAudio(file)) return { ok: false, status: 400, code: 'asset_invalid_type', error: 'Voice inspiration must be an audio file. You have not been charged.' };
    if (file.size > MAX_VOICE_BYTES) return { ok: false, status: 413, code: 'asset_too_large', error: 'Voice inspiration is too large (max 15 MB). You have not been charged.' };
    return { ok: true };
  }
  if (!isAcceptedDoc(file)) return { ok: false, status: 400, code: 'asset_invalid_type', error: 'Story inspiration must be a text, PDF, or Word document. You have not been charged.' };
  if (file.size > MAX_VOICE_BYTES) return { ok: false, status: 413, code: 'asset_too_large', error: 'Story inspiration is too large (max 15 MB). You have not been charged.' };
  return { ok: true };
}

async function uploadAssetFile(draftId: string, category: IntakeAssetCategory, file: File, familyCharacterIndex: number | null): Promise<UploadedPhotoRef | null> {
  if (category === 'primary_photo') return uploadOrderPhoto(draftId, file);
  if (category === 'guided_child_reference') return uploadOrderGuidedPhoto(draftId, 0, file);
  if (category === 'supporting_character_reference') return uploadOrderSupportingPhoto(draftId, familyCharacterIndex ?? 0, file);
  return uploadOrderVoice(draftId, file);
}

export async function addIntakeAsset(params: {
  draftId: string;
  category: IntakeAssetCategory;
  file: File;
  guidedPhotoConsent?: boolean;
  label?: string | null;
  familyCharacterId?: string | null;
  familyCharacterIndex?: number | null;
  source?: 'upload' | 'guided_capture' | 'recorded' | null;
  now?: string;
}): Promise<{ draft: IntakeDraftRecord; asset: IntakeAssetRef }> {
  const draft = await getIntakeDraft(params.draftId);
  if (!draft) throw new OrderPersistenceError(params.draftId, 'Draft order not found');
  if (draft.status === 'finalized') throw new OrderPersistenceError(params.draftId, 'Draft order already finalized');

  // NOTE / TODO (reload-safe dedupe — Part D follow-up):
  // This function mints a NEW assetId per call and only enforces per-category
  // caps below — it does NOT dedupe by a stable client localId or content hash.
  // That means duplicate protection is currently SAME-SESSION ONLY, enforced on
  // the client by uploadedAssetIdsRef (File-identity cache) + planAssetUploads.
  // A retry whose first PUT actually landed but whose response was lost (e.g.
  // reload/resume, where the in-memory File identity is gone) is NOT guaranteed
  // to be idempotent here: on a multi-asset category it could append a second
  // copy, and on a singleton category it 4xxs on the cap. The CD spec's
  // "server dedupes by localId" invariant is therefore NOT yet implemented.
  // Follow-up to make reload/resume duplicate-proof: accept an optional
  // `localId` (and/or content hash) from the assets route, and short-circuit
  // here returning the existing asset when (draftId, localId) already exists.
  // Until then, do not promise reload-safe dedupe in customer-facing copy.
  const existingForCategory = draft.assets.filter((asset) => asset.category === params.category);
  if (params.category === 'primary_photo' && existingForCategory.length >= 1) {
    const error = new Error('Only one primary child photo can be uploaded for this draft. You have not been charged.') as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = 'primary_photo_limit';
    throw error;
  }
  if (params.category === 'guided_child_reference') {
    if (params.guidedPhotoConsent !== true) {
      const error = new Error('Parent/guardian photo consent is required before uploading guided reference photos. You have not been charged.') as Error & { status?: number; code?: string };
      error.status = 400;
      error.code = 'guided_photo_consent_required';
      throw error;
    }
    const existingGuidedBytes = existingForCategory.reduce((total, asset) => total + Math.max(0, asset.size || 0), 0);
    if (existingForCategory.length >= MAX_GUIDED_PHOTOS || existingGuidedBytes + params.file.size > MAX_GUIDED_PHOTOS_TOTAL_BYTES) {
      const error = new Error('Too many guided reference photos for this draft. You have not been charged.') as Error & { status?: number; code?: string };
      error.status = 413;
      error.code = 'guided_photo_limit';
      throw error;
    }
  }
  if (params.category === 'supporting_character_reference') {
    const familyIndex = Number.isInteger(params.familyCharacterIndex) ? params.familyCharacterIndex! : -1;
    const alreadyUploadedForCharacter = draft.assets.some((asset) => asset.category === 'supporting_character_reference' && asset.familyCharacterIndex === familyIndex);
    if (familyIndex < 0 || familyIndex >= draft.familyCharacters.length || alreadyUploadedForCharacter) {
      const error = new Error('Only one supporting family reference can be uploaded for each listed character. You have not been charged.') as Error & { status?: number; code?: string };
      error.status = 400;
      error.code = 'family_reference_limit';
      throw error;
    }
  }
  if ((params.category === 'voice_inspiration' || params.category === 'document_inspiration') && existingForCategory.length >= 1) {
    const error = new Error('Only one story inspiration file can be uploaded for this draft. You have not been charged.') as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = 'story_inspiration_limit';
    throw error;
  }

  const validation = validateIntakeAssetFile(params.category, params.file);
  if (validation.ok === false) {
    const error = new Error(validation.error) as Error & { status?: number; code?: string };
    error.status = validation.status;
    error.code = validation.code;
    throw error;
  }
  const uploaded = await uploadAssetFile(draft.id, params.category, params.file, params.familyCharacterIndex ?? null);
  const now = params.now ?? new Date().toISOString();
  const asset: IntakeAssetRef = {
    assetId: newAssetId(),
    category: params.category,
    blobPath: uploaded?.pathname ?? null,
    blobUrl: uploaded?.url ?? null,
    fileName: params.file.name || null,
    mime: params.file.type || null,
    size: params.file.size,
    label: sanitizeGuidedPhotoLabel(params.label ?? params.category),
    familyCharacterId: params.familyCharacterId ?? null,
    familyCharacterIndex: Number.isInteger(params.familyCharacterIndex) ? params.familyCharacterIndex! : null,
    source: params.source ?? (params.category === 'guided_child_reference' ? 'guided_capture' : 'upload'),
    uploadedAt: now,
  };
  const next: IntakeDraftRecord = {
    ...draft,
    status: 'assets_uploaded',
    updatedAt: now,
    assets: [...draft.assets, asset],
    consent: {
      ...draft.consent,
      guidedPhotoConsentAt: params.category === 'guided_child_reference' && params.guidedPhotoConsent === true ? now : draft.consent.guidedPhotoConsentAt ?? null,
      voiceConsentAt: params.category === 'voice_inspiration' ? now : draft.consent.voiceConsentAt ?? null,
    },
  };
  await persistIntakeDraft(next);
  return { draft: next, asset };
}

function findAsset(draft: IntakeDraftRecord, assetId: string | null | undefined, category?: IntakeAssetCategory): IntakeAssetRef | null {
  if (!assetId) return null;
  return draft.assets.find((asset) => asset.assetId === assetId && (!category || asset.category === category)) ?? null;
}

function selectedFamilyReferenceAssetIds(input: FinalizeIntakeInput): Set<string> | null {
  const raw = input.familyCharacterReferenceAssetIds;
  if (!raw) return null;
  const ids = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) if (item?.assetId) ids.add(item.assetId);
  } else {
    for (const value of Object.values(raw)) {
      if (Array.isArray(value)) value.filter(Boolean).forEach((assetId) => ids.add(assetId));
      else if (value) ids.add(value);
    }
  }
  return ids;
}

export interface FinalizeIntakeInput {
  draftOrderId: string;
  primaryPhotoAssetId?: string | null;
  guidedChildReferenceAssetIds?: string[] | null;
  familyCharacterReferenceAssetIds?: Record<string, string | string[]> | Array<{ familyCharacterIndex?: number | null; familyCharacterId?: string | null; assetId: string }> | null;
  voiceAssetId?: string | null;
  documentAssetIds?: string[] | null;
  finalConsent?: { photos?: boolean; voice?: boolean; terms?: boolean } | null;
  fields?: Partial<OrderInput> | null;
}

export function buildOrderInputFromDraft(draft: IntakeDraftRecord, input: FinalizeIntakeInput): OrderInput {
  const fields = { ...draft.fields, ...(input.fields ?? {}) } as OrderInput;
  const primary = findAsset(draft, input.primaryPhotoAssetId, 'primary_photo');
  const guidedIds = new Set((input.guidedChildReferenceAssetIds ?? []).filter(Boolean));
  const guidedAssets = draft.assets.filter((asset) => asset.category === 'guided_child_reference' && guidedIds.has(asset.assetId));
  const selectedFamilyIds = selectedFamilyReferenceAssetIds(input);
  const familyCharacters = draft.familyCharacters.map((character, index) => {
    const matching = draft.assets.filter((asset) => {
      if (asset.category !== 'supporting_character_reference') return false;
      if (selectedFamilyIds && !selectedFamilyIds.has(asset.assetId)) return false;
      if (asset.familyCharacterIndex === index) return true;
      const idKey = `family-${index}`;
      if (asset.familyCharacterId && asset.familyCharacterId === idKey) return true;
      return false;
    });
    const refs: FamilyCharacterReferencePhoto[] = matching.map((asset) => ({
      assetId: asset.assetId,
      label: asset.label ?? null,
      fileName: asset.fileName,
      photoBlobPath: asset.blobPath,
      photoBlobUrl: asset.blobUrl,
      source: asset.source === 'guided_capture' ? 'guided_capture' : 'upload',
      consentAt: asset.uploadedAt,
    }));
    const first = refs[0] ?? null;
    return {
      ...character,
      photoFileName: first?.fileName ?? character.photoFileName ?? null,
      photoBlobPath: first?.photoBlobPath ?? character.photoBlobPath ?? null,
      photoBlobUrl: first?.photoBlobUrl ?? character.photoBlobUrl ?? null,
      referencePhotos: refs.length > 0 ? refs : character.referencePhotos ?? null,
    };
  });
  const voice = findAsset(draft, input.voiceAssetId, 'voice_inspiration');
  const documentIds = new Set((input.documentAssetIds ?? []).filter(Boolean));
  const document = draft.assets.find((asset) => asset.category === 'document_inspiration' && documentIds.has(asset.assetId)) ?? null;
  const inspiration = voice ?? document;
  const guidedReferencePhotos: GuidedReferencePhotoRecord[] = guidedAssets.map((asset) => ({
    assetId: asset.assetId,
    label: asset.label ?? 'reference',
    fileName: asset.fileName || 'reference-photo.jpg',
    photoBlobPath: asset.blobPath,
    photoBlobUrl: asset.blobUrl,
    source: 'guided_capture',
    consentAt: asset.uploadedAt,
  } as GuidedReferencePhotoRecord & { assetId: string }));
  return {
    ...fields,
    familyCharacters,
    photoFileName: primary?.fileName ?? fields.photoFileName ?? null,
    photoBlobPath: primary?.blobPath ?? fields.photoBlobPath ?? null,
    photoBlobUrl: primary?.blobUrl ?? fields.photoBlobUrl ?? null,
    voiceFileName: inspiration?.fileName ?? fields.voiceFileName ?? null,
    voiceBlobPath: inspiration?.blobPath ?? fields.voiceBlobPath ?? null,
    voiceBlobUrl: inspiration?.blobUrl ?? fields.voiceBlobUrl ?? null,
    voiceConsentAt: inspiration?.uploadedAt ?? fields.voiceConsentAt ?? null,
    voiceSource: voice?.source === 'recorded' ? 'recorded' : inspiration ? 'uploaded' : fields.voiceSource ?? null,
    guidedReferencePhotos: guidedReferencePhotos.length > 0 ? guidedReferencePhotos : fields.guidedReferencePhotos ?? null,
  };
}

export function validateFinalizeAssets(draft: IntakeDraftRecord, input: FinalizeIntakeInput): { ok: true } | { ok: false; code: string; error: string } {
  if (draft.status === 'finalized') return { ok: false, code: 'draft_already_finalized', error: 'This draft order was already finalized. You have not been charged again.' };
  const familyReferenceIds = selectedFamilyReferenceAssetIds(input);
  const allSelected = [input.primaryPhotoAssetId, input.voiceAssetId, ...(input.guidedChildReferenceAssetIds ?? []), ...(input.documentAssetIds ?? []), ...(familyReferenceIds ? [...familyReferenceIds] : [])].filter(Boolean) as string[];
  for (const assetId of allSelected) {
    if (!findAsset(draft, assetId)) return { ok: false, code: 'asset_ref_unknown', error: 'One uploaded asset was not found for this draft. You have not been charged.' };
  }
  if (input.primaryPhotoAssetId && !findAsset(draft, input.primaryPhotoAssetId, 'primary_photo')) {
    return { ok: false, code: 'primary_photo_missing', error: 'Your child reference photo was not securely saved. You have not been charged.' };
  }
  if ((input.guidedChildReferenceAssetIds ?? []).some((assetId) => !findAsset(draft, assetId, 'guided_child_reference'))) {
    return { ok: false, code: 'guided_refs_missing', error: 'One guided reference photo was not securely saved. You have not been charged.' };
  }
  if (familyReferenceIds && [...familyReferenceIds].some((assetId) => !findAsset(draft, assetId, 'supporting_character_reference'))) {
    return { ok: false, code: 'family_refs_missing', error: 'One family reference photo was not securely saved. You have not been charged.' };
  }
  if (input.voiceAssetId && !findAsset(draft, input.voiceAssetId, 'voice_inspiration')) {
    return { ok: false, code: 'voice_ref_missing', error: 'Your story inspiration audio was not securely saved. You have not been charged.' };
  }
  if ((input.documentAssetIds ?? []).some((assetId) => !findAsset(draft, assetId, 'document_inspiration'))) {
    return { ok: false, code: 'document_ref_missing', error: 'Your story inspiration document was not securely saved. You have not been charged.' };
  }
  if ((input.voiceAssetId || (input.documentAssetIds ?? []).length > 0) && input.finalConsent?.voice !== true) {
    return { ok: false, code: 'voice_consent_required', error: 'Parent/guardian consent is required to attach story inspiration. You have not been charged.' };
  }
  return { ok: true };
}

export async function finalizeIntakeDraft(input: FinalizeIntakeInput, now = new Date().toISOString()): Promise<{ draft: IntakeDraftRecord; order: OrderRecord }> {
  const draft = await getIntakeDraft(input.draftOrderId);
  if (!draft) throw new OrderPersistenceError(input.draftOrderId, 'Draft order not found');
  const validation = validateFinalizeAssets(draft, input);
  if (validation.ok === false) {
    const error = new Error(validation.error) as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = validation.code;
    throw error;
  }
  const orderInput = buildOrderInputFromDraft(draft, input);
  const order = createOrderRecord(orderInput);
  const persisted = await persistOrder(order);
  const next: IntakeDraftRecord = {
    ...draft,
    status: 'finalized',
    updatedAt: now,
    finalizedAt: now,
    orderId: persisted.id,
  };
  await persistIntakeDraft(next);
  return { draft: next, order: persisted };
}

export function isSplitAssetIntakeEnabled(envValue = process.env.NEXT_PUBLIC_HSB_SPLIT_ASSET_INTAKE) {
  return envValue === 'true';
}

/**
 * Per-file upload idempotency planner for the split-asset checkout client.
 *
 * Each asset is uploaded once via POST /api/order/draft/{id}/assets. If a later
 * file in the batch fails, the customer retries the whole submit — but the
 * server enforces per-category caps (primary_photo_limit, family_reference_limit,
 * story_inspiration_limit, guided_photo_limit), so re-uploading an
 * already-saved file is REJECTED and would break the retry. Given the map of
 * files already uploaded in a prior attempt (file → assetId), this returns only
 * the files that still need uploading plus the assetIds to reuse for the rest,
 * so a retry never re-sends a successful upload. Order is preserved.
 *
 * Pure + generic so it is unit-testable without a DOM (the client keys by the
 * in-memory File object, whose identity is stable across retries).
 */
export function planAssetUploads<T>(
  files: readonly T[],
  alreadyUploaded: ReadonlyMap<T, string>,
): { pending: T[]; reusedAssetIds: string[] } {
  const pending: T[] = [];
  const reusedAssetIds: string[] = [];
  for (const file of files) {
    const existing = alreadyUploaded.get(file);
    if (existing) {
      reusedAssetIds.push(existing);
    } else {
      pending.push(file);
    }
  }
  return { pending, reusedAssetIds };
}
