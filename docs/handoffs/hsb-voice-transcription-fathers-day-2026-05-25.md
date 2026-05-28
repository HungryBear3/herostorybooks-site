# Claude Code Prompt - HSB Voice-Note Transcription for Father's Day

You are Claude Code working in:

`/Users/abigailclaw/.openclaw/workspace/herostorybooks-site`

Task: finish the existing optional voice-note beta so the "record your story" / "let your child help tell the story" feature actually influences story generation for the Father's Day sales push.

Context:
- The voice-note UI already exists at `src/components/checkout/VoiceRecorderSection.tsx`.
- Checkout mounts it only when `NEXT_PUBLIC_HSB_VOICE_BETA === "true"` in `src/app/checkout/checkout-form.tsx`.
- `/api/order` already accepts `voice`, requires parent/guardian consent, validates audio, caps at 15 MB, uploads it before Stripe, and persists voice metadata.
- `src/lib/fulfillment.ts` currently has a TODO around `HSB_VOICE_TRANSCRIPTION_ENABLED`; the audio is not yet transcribed or fed into story planning.
- OpenAI current speech-to-text docs: use `openai.audio.transcriptions.create` with model `gpt-4o-mini-transcribe` or `gpt-4o-transcribe`; file input supports webm and common audio formats; file uploads are limited to 25 MB. Our app already caps at 15 MB, so keep that.

Hard boundaries:
- Do not deploy production.
- Do not post/schedule social media.
- Do not add or touch any LinkedIn publishing route. Alexy approved social posting generally but explicitly said to hold LinkedIn.
- Do not touch Stripe/Lulu/payment/fulfillment external actions beyond local code/tests.
- Do not use Gemini/Nano Banana for HSB.
- Do not use the audio for voice cloning, generated speech, imitation, or published audio. It is only for text transcription and story inspiration.
- Work with the dirty tree; do not revert unrelated changes. Keep edits scoped to voice transcription + checkout/Father's Day copy/tests/docs.

Implementation goal:
1. Add a narrow server-side transcription path behind `HSB_VOICE_TRANSCRIPTION_ENABLED === "true"`.
2. Use the OpenAI audio transcription endpoint via the existing `openai` package if available. Prefer model env `HSB_VOICE_TRANSCRIPTION_MODEL`, default `gpt-4o-mini-transcribe`.
3. Transcribe the attached voice note only after explicit consent and only for the current order.
4. Convert raw transcript into a short bounded "voice inspiration" text that can safely enter story generation. It should extract preferences, favorite phrases, emotional tone, adventure ideas, people/objects mentioned, and Father's Day/dad cues if present.
5. Persist transcript metadata on the order record, including at least:
   - raw transcript or a safely truncated transcript
   - inspiration summary
   - transcription model
   - timestamp
   - failure/error marker if transcription failed
6. Feed the inspiration summary into story generation/planning so generated prose can reflect it. Keep this additive and bounded; if missing or failed, existing story generation must behave exactly as before.
7. Update checkout copy for Father's Day framing without overpromising:
   - keep it optional
   - call it a "voice note" or "record a 30-second story idea"
   - say it helps personalize the writing
   - explicitly say it is not voice cloning and not published
8. If enabling the UI for preview/release requires env setup, document exactly which Vercel env vars are needed. Do not set secrets unless already present and safe; do not production deploy.

Recommended shape:
- Add a small helper like `src/lib/voice-transcription.ts`.
- Keep OpenAI import isolated so tests can mock/fake it.
- Make the helper no-op unless `HSB_VOICE_TRANSCRIPTION_ENABLED === "true"`, `OPENAI_API_KEY` exists, and a voice file/blob exists.
- Prefer transcribing the `File` while `/api/order` still has it, after upload succeeds but before `createOrderRecord`, so we do not need to fetch Vercel Blob bytes again. If that creates too much checkout latency, document the tradeoff and implement the safer fulfillment-time path instead.
- If transcription fails, checkout should continue and persist a failure marker; do not block payment unless the voice file itself cannot be securely stored.

Tests / verification:
- Extend `tests/voice-upload.test.ts` or add focused tests for:
  - transcription path is feature-flagged off by default
  - no OpenAI call when no consent/no voice/no flag
  - transcription metadata is persisted when helper returns transcript/inspiration
  - failed transcription does not block order creation
  - story generation prompt includes the bounded voice inspiration when present
  - checkout copy still contains no voice-cloning promise
- Run the smallest meaningful focused tests first, then `npm test` and `npm run build` if feasible.
- If lint is still blocked by repo config, state that.

Deliverables:
- Commit locally if tests/build pass.
- Create a preview deployment only if the branch is in a deployable state and checks pass. Preview only, no `--prod`.
- Final report should include changed files, commit hash if committed, tests/build result, preview URL if created, and exact env vars needed for Father’s Day release.
