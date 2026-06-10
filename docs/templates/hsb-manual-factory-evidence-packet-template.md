# HSB Manual Factory Evidence Packet Template

Use this for Telegram/ops reporting after manual factory milestones.

## Short status format

```md
HSB manual factory — <PASS/WARN/FAIL>
- Order: `<orderId>`
- Stage: `<paid/manual_generation_required/imported/awaiting_qa/qa_passed/proof_released/customer_approved>`
- Commit/deploy: `<sha/deployment or local-only>`
- Artifact manifest: `<path/blob ref>`
- Artifacts: `<complete|missing: ...>`
- QA: `<pending|passed|failed>`
- Customer email: `<none|ack sent|proof sent|approval confirmation sent>`
- Print: `<not submitted|owner-go pending|submitted job ...>`
- Blockers: `<none/list>`
- Side effects: `<exact list>`
```

## Full report format

```md
## HSB manual factory report

Verdict: PASS / WARN / FAIL

Order:
- ID: `<orderId>`
- Product: `<digital/print>`
- Payment: `<paid/unpaid/refunded>`
- Customer release: `<not released/released at ts>`
- Print: `<not submitted/submitted job id>`

Code/build:
- Branch/commit: `<branch sha>`
- Deployment: `<none/preview/prod id>`
- Verification: `<tests/build/checks>`

State transitions:
- After payment: `<status>`
- After artifact import: `<status>`
- After QA: `<status>`
- After proof release: `<status>`
- After customer approval: `<status>`

Artifacts:
- Manifest: `<path/blob ref>`
- Story brief: `<present/missing ref>`
- Page plan: `<present/missing ref>`
- Prose: `<present/missing ref>`
- Art direction: `<present/missing ref>`
- Page images: `<count>/<expected>`
- Proof PDF: `<present/missing ref>`
- QA report: `<present/missing ref>`

Guard results:
- Manifest complete: `<yes/no>`
- Template/fallback source blocked: `<yes/no/not applicable>`
- Missing artifacts blocked: `<yes/no/not applicable>`
- Release guard: `<pass/fail reason>`
- Print guard: `<blocked until customer approval + owner print-go / pass>`

Email events:
- Paid acknowledgement: `<not sent/sent id/status>`
- Proof-ready review email: `<not sent/sent id/status>`
- Customer-approved confirmation: `<not sent/sent id/status>`

Side-effect attestation:
- Prod deploy/env: `<none/list>`
- Order mutation: `<none/list>`
- Payment/refund: `<none/list>`
- Customer email: `<none/list>`
- Proof release: `<none/list>`
- Print/Lulu/RPI: `<none/list>`

Blockers / next action:
- `<list>`
```

## Failure report add-on

```md
Stop reason: `<reason>`
First bad state: `<state>`
Expected state: `<state>`
Evidence path/log: `<path>`
Rollback/containment: `<action or none needed>`
Needs approval for next mutation: `<yes/no; exact approval phrase>`
```
