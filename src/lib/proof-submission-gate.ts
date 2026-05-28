import { ArtDirectionPacketSchema } from './art-direction-schemas.ts';
import type { OrderRecord, ProofReleaseOverride, ReviewAuditEvent } from './orders.ts';
import type { StoryMeta } from './fulfillment-types.ts';
import { STORY_OCCASIONS } from './story-catalog.ts';
import { validateStoryboardCompleteness } from './storyboard-validator.ts';

const CUSTOM_STORY_THEME_ID = 'custom-voice-story';
const STANDARD_LESSON_IDS = new Set(['courage', 'kindness', 'friendship', 'creativity', 'perseverance']);
const STANDARD_OCCASION_IDS = new Set(STORY_OCCASIONS.map((occasion) => occasion.id));
const MAX_OVERRIDE_REASON_CHARS = 500;

export type ProofSubmissionGateReasonCode =
  | 'custom_story_source_missing'
  | 'custom_story_template_source'
  | 'custom_story_template_fallback'
  | 'art_direction_packet_missing'
  | 'art_direction_packet_invalid'
  | 'storyboard_incomplete'
  | 'human_override_invalid';

export interface ProofSubmissionGateReason {
  code: ProofSubmissionGateReasonCode;
  message: string;
  detail?: string;
}

export interface ProofSubmissionGateResult {
  allowed: boolean;
  gated: boolean;
  reasons: ProofSubmissionGateReason[];
  overrideApplied: boolean;
}

function hasCustomLessonOrOccasion(order: OrderRecord): boolean {
  const lesson = (order.lesson ?? '').trim();
  if (lesson && !STANDARD_LESSON_IDS.has(lesson)) return true;

  const occasion = (order.occasion ?? '').trim();
  if (occasion && !STANDARD_OCCASION_IDS.has(occasion)) return true;

  return false;
}

export function isCustomProofGatedOrder(order: OrderRecord): boolean {
  return (
    order.theme === CUSTOM_STORY_THEME_ID ||
    Boolean(order.voiceFileName || order.voiceBlobPath || order.voiceBlobUrl || order.voiceConsentAt || order.voiceSource) ||
    Boolean(order.voiceTranscript?.transcript || order.voiceTranscript?.inspiration) ||
    hasCustomLessonOrOccasion(order)
  );
}

function validTimestamp(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return time <= now.getTime() + 5 * 60 * 1000;
}

function matchingOverrideAudit(
  override: ProofReleaseOverride,
  auditEvents: ReviewAuditEvent[] | undefined,
): boolean {
  return (auditEvents ?? []).some((event) =>
    event.type === 'proof_release_override_recorded' &&
    event.at === override.recordedAt &&
    event.meta?.recordedBy === override.recordedBy &&
    event.meta?.scope === override.scope,
  );
}

export function isValidProofReleaseOverride(
  order: OrderRecord,
  now: Date = new Date(),
): boolean {
  const override = order.proofReleaseOverride;
  if (!override) return false;
  if (!override.recordedBy.trim()) return false;
  if (!override.reason.trim() || override.reason.length > MAX_OVERRIDE_REASON_CHARS) return false;
  if (!validTimestamp(override.recordedAt, now)) return false;
  if (override.expiresAt && Date.parse(override.expiresAt) <= now.getTime()) return false;
  return matchingOverrideAudit(override, order.auditEvents);
}

export function evaluateProofSubmissionGate(
  order: OrderRecord,
  options: { storyMeta?: StoryMeta | null; now?: Date } = {},
): ProofSubmissionGateResult {
  const storyMeta = options.storyMeta ?? order.storyMeta ?? null;
  const now = options.now ?? new Date();
  const gated = isCustomProofGatedOrder(order);
  if (!gated) {
    return { allowed: true, gated: false, reasons: [], overrideApplied: false };
  }

  const reasons: ProofSubmissionGateReason[] = [];

  if (!storyMeta?.source) {
    reasons.push({
      code: 'custom_story_source_missing',
      message: 'Custom order is missing persisted story source metadata.',
    });
  } else if (storyMeta.source === 'template') {
    reasons.push({
      code: 'custom_story_template_source',
      message: 'Custom order used deterministic template story source.',
      detail: `source=${storyMeta.source} model=${storyMeta.model}`,
    });
  } else if (storyMeta.source === 'template_after_openai_failure') {
    reasons.push({
      code: 'custom_story_template_fallback',
      message: 'Custom order fell back to template_after_openai_failure.',
      detail: storyMeta.fallbackError ?? undefined,
    });
  }

  const packetResult = ArtDirectionPacketSchema.safeParse(order.artDirectionPacket);
  if (!order.artDirectionPacket) {
    reasons.push({
      code: 'art_direction_packet_missing',
      message: 'Custom order is missing art-direction/storyboard packet.',
    });
  } else if (!packetResult.success) {
    reasons.push({
      code: 'art_direction_packet_invalid',
      message: 'Custom order art-direction packet does not match schema.',
      detail: packetResult.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    });
  } else {
    const validation = validateStoryboardCompleteness(packetResult.data);
    if (validation.status !== 'complete') {
      reasons.push({
        code: 'storyboard_incomplete',
        message: 'Custom order storyboard is incomplete.',
        detail: validation.errors.slice(0, 3).map((issue) => `${issue.code}:${issue.path}`).join('; '),
      });
    }
  }

  if (reasons.length === 0) {
    return { allowed: true, gated: true, reasons: [], overrideApplied: false };
  }

  if (isValidProofReleaseOverride(order, now)) {
    return { allowed: true, gated: true, reasons, overrideApplied: true };
  }

  if (order.proofReleaseOverride) {
    reasons.push({
      code: 'human_override_invalid',
      message: 'Proof release override is missing required bounded fields, is expired, or lacks a matching audit event.',
    });
  }

  return { allowed: false, gated: true, reasons, overrideApplied: false };
}

export function formatProofSubmissionGateReasons(reasons: ProofSubmissionGateReason[]): string {
  return reasons.map((reason) => reason.code).join(', ');
}
