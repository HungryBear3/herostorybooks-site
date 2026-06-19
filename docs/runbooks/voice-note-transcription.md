# Runbook — Voice-note transcription (Father's Day beta)

> **Status:** beta, OFF by default. Optional child-voice note → text transcript
> → bounded "voice inspiration" fed into story prose. The audio is used for
> transcription + story inspiration **only**. It is **never** used for voice
> cloning, generated speech, imitation, or published audio.

## What it does

1. The checkout voice UI (`VoiceRecorderSection`) is gated by
   `NEXT_PUBLIC_HSB_VOICE_BETA` and only submits a voice file with explicit
   parent/guardian consent.
2. `/api/order` validates + uploads the audio (15 MB cap) before Stripe, then —
   if transcription is enabled — calls `transcribeVoiceNote()` on the in-request
   `File` (no re-fetch of blob bytes).
3. The transcript is truncated and turned into a short bounded `inspiration`
   summary (`src/lib/voice-transcription.ts`). Both, plus the model, a
   timestamp, and a failure marker, are persisted on the order as
   `voiceTranscript` (`VoiceTranscriptMeta`).
4. At fulfillment, story generation reads `order.voiceTranscript.inspiration`
   and adds a bounded "VOICE NOTE INSPIRATION" block to the prose prompt
   (`voiceInspirationBlock` in `src/lib/story-generator.ts`). If it's missing or
   the transcription failed, the prompt is byte-identical to the pre-voice path.

## Environment variables (Vercel)

To enable the **end-to-end** voice beta for the Father's Day release, set these
on the target environment (Preview first, then Production when ready):

| Var | Where | Required | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_HSB_VOICE_BETA` | Build-time (client) | yes, to show the UI | `"true"` mounts the recorder at checkout. This is a **public** build var — set it on the environments where you want the UI visible. |
| `HSB_VOICE_TRANSCRIPTION_ENABLED` | Server runtime | yes, to transcribe | `"true"` turns on the server transcription path. With it unset/anything-else, `transcribeVoiceNote()` is a hard no-op (no OpenAI call). |
| `OPENAI_API_KEY` | Server runtime | yes, to transcribe | Already used by the OpenAI story paths. Without it, transcription is a no-op even when the flag is on. |
| `HSB_VOICE_TRANSCRIPTION_MODEL` | Server runtime | optional | Defaults to `gpt-4o-mini-transcribe`. Set to `gpt-4o-transcribe` for higher quality at higher cost. |
| `BLOB_READ_WRITE_TOKEN` | Server runtime | yes (already set) | Needed to durably store the audio before Stripe (existing requirement). |

**Minimum to ship the beta:** `NEXT_PUBLIC_HSB_VOICE_BETA=true` +
`HSB_VOICE_TRANSCRIPTION_ENABLED=true` + an existing `OPENAI_API_KEY`.

Do **not** set any secrets that aren't already provisioned. No production deploy
should be performed as part of enabling this — promote via a Preview deployment
first.

## Latency tradeoff (where transcription runs)

Transcription runs **synchronously inside `/api/order`, before the Stripe
Checkout Session**, so the persisted order already carries the transcript when
the webhook later kicks off fulfillment. This adds the transcription round-trip
(typically a few seconds for a 30–60s clip on `gpt-4o-mini-transcribe`) to the
checkout request **only when the flag is on**. We accept this while the feature
is beta + low-volume, in exchange for not having to re-fetch the audio bytes
from Vercel Blob at fulfillment time.

If checkout latency becomes a problem, move the call off the critical path:
transcribe at fulfillment time from `order.voiceBlobUrl` (download the blob,
wrap it in a `File`/`toFile`, call the same `transcribeVoiceNote` shape) instead
of in the route. The persisted `VoiceTranscriptMeta` contract and the story
prompt integration stay the same.

## Failure behavior

- **Transcription failure never blocks payment.** `transcribeVoiceNote()`
  catches its own errors and returns a `VoiceTranscriptMeta` with `error` set
  and `transcript`/`inspiration` null. The route persists that marker and
  continues to Stripe.
- The **only** voice-related abort-before-Stripe is an unstorable audio *file*
  (`OrderPersistenceError` from `uploadOrderVoice`) — unchanged from before.
- A failed/absent transcription means story generation behaves exactly as it
  did before the voice beta (no inspiration block).

## Privacy / scope guardrails

- Audio → text only. No cloning, no synthesized speech, no published audio.
- The `inspiration` summary is bounded (~600 chars) and the prose prompt forbids
  verbatim quoting or any mention of a recording/microphone in the story.
- Consent is enforced in `/api/order` (`voice_consent_required`) before any
  upload or transcription.

## Retention / deletion

**Status (2026-05-26):** the unbacked automated-deletion promise has been
**removed** from the checkout copy. `VoiceRecorderSection.tsx` no longer says
"Deleted after your book ships." It now says the audio is used only to write
the book, is never shared, and offers **manual deletion on request**
(`support@herostorybooks.com`). Those are claims we can honor today.

Current behavior: the audio is uploaded to Vercel Blob at
`orders/<orderId>/voice-<name>` and is **never automatically deleted** — there
is no post-ship pruning job and no deletion call in the codebase.

### Honoring a manual deletion request (support)
The voice blob path is `orders/<orderId>/voice-<safeFileName>` (namespaced by
`HSB_BLOB_NAMESPACE` on preview/dev). To delete one, use `del()` from
`@vercel/blob` with `BLOB_READ_WRITE_TOKEN`, then null out `voiceBlobPath` /
`voiceBlobUrl` / `voiceTranscript` on the order record. (No turnkey script
exists yet — this is a manual op.)

### Remaining blocker — automated deletion-on-ship sweep (NOT implemented)
Before re-introducing any **automated** "deleted after your book ships" claim,
implement a feature-flagged sweep (e.g. `HSB_VOICE_DELETE_ON_SHIP`) that:
- finds orders that are `shipped` (print) or delivered/`complete` (digital) and
  still have a `voiceBlobPath`,
- deletes the voice blob via `del()`,
- records a `voiceDeletedAt` marker so the sweep is idempotent.

Until that ships, do not add automated-deletion copy back.
