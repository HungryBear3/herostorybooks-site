# Fable character-review integration

Fable's snapshot e678019c copy is a proposal, not a policy or API authority.

Integrated: friendly status labels with unknown fallback; pre-decision approval scope and native accessible confirmation; explicit missing-fragment invitation guidance; generic authenticated lookup failures (no expiry/revocation disclosure); decoded-image approval gate; note counter/hint; busy states, mobile stacking, and post-save focus.

Capability remains fragment-only and in-memory. Refresh still requires reopening the invitation: no local/session storage, cookie or URL-query persistence was added. Customer responses remain version-bound and do not release proofs or approve printing.

Saved-note display only uses an optional authorized response `comment`; current API does not supply it, so this display remains dormant. It does not label an unsaved textarea draft as persisted. API changes to expose notes require scoped review.

Not adopted: promises that production has started or starts immediately; raw internal status; expiry-versus-supersession distinctions; support address or mailbox routing not verified; absolute privacy claim; unlimited revision claim (history is bounded); any new post-approval changes policy. Notification drafts remain unsent.

Verification: production Next build via hermetic Playwright server (provider/payment/email credentials blank); real customer decision routes and local CAS; synthetic image storage only. Desktop/mobile approve and request-change paths, confirmation cancel/focus, invalid invitation, missing-token refresh, undecodable image and failed-save retention covered. No live customer/provider operation.
