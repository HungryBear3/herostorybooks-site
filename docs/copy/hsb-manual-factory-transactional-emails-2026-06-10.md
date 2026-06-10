# HSB Manual Factory Transactional Email Copy

Status: draft copy. Implementation must use existing sender/support helpers and unsubscribe/compliance conventions already present in the app.

## Rules

- Keep copy calm, handcrafted, and honest.
- Do not promise instant generation.
- Do not expose internal state names like `manual_generation_required`.
- Do not mention provider/tool names.
- Do not imply print has started until owner print-go actually submits print.
- Proof release and print submission remain separate events.

## 1. Paid acknowledgement email

Trigger: Stripe checkout completes and order is marked paid/parked for manual factory.

Purpose: prevent post-checkout silence and set proof expectation.

Subject options:
- `We’ve got your Hero Story Books order — your proof is next`
- `Your custom book is in production`
- `We’re preparing your handcrafted proof`

Recommended subject:
`We’ve got your Hero Story Books order — your proof is next`

Plain text:
```txt
Hi {{parentName}},

Thanks — we received your order for {{childName}}’s custom book.

Next, we’re preparing a handcrafted digital proof for you to review. You’ll get another email when the proof is ready.

Nothing goes to print until the proof is reviewed and approved.

Order: {{orderId}}

Questions or corrections? Reply to this email or contact {{supportEmail}}.

— Hero Story Books
```

HTML body draft:
```html
<p>Hi {{parentName}},</p>

<p>Thanks — we received your order for <strong>{{childName}}’s custom book</strong>.</p>

<p>Next, we’re preparing a handcrafted digital proof for you to review. You’ll get another email when the proof is ready.</p>

<p><strong>Nothing goes to print until the proof is reviewed and approved.</strong></p>

<p style="color:#6b7280;font-size:14px;">Order: {{orderId}}</p>

<p>Questions or corrections? Reply to this email or contact <a href="mailto:{{supportEmail}}">{{supportEmail}}</a>.</p>

<p>— Hero Story Books</p>
```

Implementation notes:
- This may be sent in paid webhook path.
- It is not proof release.
- It must not include proof/review link.
- It must not schedule print.

## 2. Proof ready / customer review email

Trigger: explicit release-proof action after artifact completeness + QA pass + release guard.

Purpose: deliver review link and ask customer to approve/request changes.

Subject options:
- `{{childName}}’s custom book proof is ready`
- `Your Hero Story Books proof is ready to review`
- `Review {{childName}}’s book proof`

Recommended subject:
`{{childName}}’s custom book proof is ready`

Plain text:
```txt
Hi {{parentName}},

{{childName}}’s custom book proof is ready to review.

Open your proof here:
{{reviewUrl}}

Please review the pages carefully. If everything looks good, approve the proof in the review page. If something needs a fix, request changes there or reply to this email.

Nothing goes to print until the proof is approved.

PDF only: {{proofUrl}}
Order: {{orderId}}

— Hero Story Books
```

HTML body draft:
```html
<p>Hi {{parentName}},</p>

<p><strong>{{childName}}’s custom book proof is ready to review.</strong></p>

<p><a href="{{reviewUrl}}" style="display:inline-block;background:#1F3A5F;color:white;padding:12px 18px;border-radius:999px;text-decoration:none;">Review the proof</a></p>

<p>Please review the pages carefully. If everything looks good, approve the proof in the review page. If something needs a fix, request changes there or reply to this email.</p>

<p><strong>Nothing goes to print until the proof is approved.</strong></p>

<p style="color:#6b7280;font-size:14px;">PDF only: <a href="{{proofUrl}}">open proof PDF</a><br>Order: {{orderId}}</p>

<p>— Hero Story Books</p>
```

Implementation notes:
- Only explicit release-proof route/action should send this.
- Must rerun release guard immediately before send.
- Must require QA pass.

## 3. Customer approved / print-routing confirmation

Trigger: customer approves proof.

Purpose: acknowledge approval and explain next step without submitting print by email side effect.

Subject options:
- `Proof approved — we’re preparing {{childName}}’s book for print`
- `Thanks — {{childName}}’s proof is approved`
- `Your proof approval is confirmed`

Recommended subject:
`Proof approved — we’re preparing {{childName}}’s book for print`

Plain text:
```txt
Hi {{parentName}},

Thanks — {{childName}}’s proof has been approved.

We’re routing the approved book into the next production step. If this order includes print, our team will complete the final print handoff after the approval checks are confirmed.

Order: {{orderId}}

Questions? Reply to this email or contact {{supportEmail}}.

— Hero Story Books
```

HTML body draft:
```html
<p>Hi {{parentName}},</p>

<p>Thanks — <strong>{{childName}}’s proof has been approved</strong>.</p>

<p>We’re routing the approved book into the next production step. If this order includes print, our team will complete the final print handoff after the approval checks are confirmed.</p>

<p style="color:#6b7280;font-size:14px;">Order: {{orderId}}</p>

<p>Questions? Reply to this email or contact <a href="mailto:{{supportEmail}}">{{supportEmail}}</a>.</p>

<p>— Hero Story Books</p>
```

Implementation notes:
- Customer approval may trigger this email.
- This email must not call Lulu/RPI/print provider.
- Print still requires owner print-go.

## Test expectations

- Paid acknowledgement has no `reviewUrl`/`proofUrl`.
- Paid acknowledgement copy includes proof-before-print reassurance.
- Proof-ready email includes `reviewUrl` and proof-before-print reassurance.
- Proof-ready email can only be sent after QA pass + release guard.
- Customer-approved email does not submit print.
- No email copy exposes internal statuses or provider names.
