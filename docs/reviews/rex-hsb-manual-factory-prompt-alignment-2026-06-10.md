# HSB Manual Factory Prompt Alignment Notes

Status: Rex alignment note for Alexy/CC/CD/Cowork.

## Recommendation

Use Abby's split prompt sequence for implementation:

1. Phase 1+2 first:
   - state machine
   - manifest schema
   - honest customer/internal copy
   - no admin surface beyond what is needed for schema tests

2. Phase 3 after Phase 1+2 is reviewed/merged:
   - minimal admin gate
   - attach artifact bundle
   - mark QA pass/fail
   - release proof
   - contract tests for release/print guard

Rex's all-in-one prompt should be treated as architecture reference/backstop, not the primary CC prompt, unless Abby's split prompt files are unavailable.

## Constraints that must be present in whichever prompt is pasted

### Manual state
- Paid order must enter `manual_generation_required`.
- It must not remain vague `not_started` after paid.
- It must not fall into `failed_manual_review` merely because automation was not run.

### Auto-generation halt
- Stripe paid path must not schedule normal auto fulfillment.
- Replay/backlog/admin retry must not auto-generate from `manual_generation_required`.

### Email checkpoints
- Paid → acknowledgement email only.
- Proof-ready/released → customer review email with proof link.
- Customer-approved → confirmation email only; no print submission.

### Admin surface limit
First cut has exactly three actions:
1. Attach artifact bundle
2. Mark QA pass/fail
3. Release proof

No per-artifact upload/edit UI in first cut.

### Blob/upload limit
Avoid Vercel/serverless request body failures:
- Do not send image/PDF bundles through one giant Next multipart body.
- Upload large artifacts directly to Blob first.
- Admin/order route receives metadata/blob refs.
- Add source/guard tests proving `/manual-artifacts` is not the large-binary transport path.

### Contract tests
Must prove:
- fallback/template source cannot reach customer proof/digital delivery
- missing artifacts cannot reach customer proof/digital delivery
- QA pass alone does not email customer
- release-proof reruns manifest/release guard
- customer approval does not submit print
- print requires customer approval + owner print-go

## Phase 4 unlock criteria

Phase 4 internal order test starts only after:
- Phase 1+2+3 code is reviewed
- tests/build pass
- production deploy is explicitly approved
- one internal paid order is explicitly approved
- one proof release email is explicitly approved

Phase 5 controlled intake starts only after Phase 4 passes as a process.
