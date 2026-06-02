# Vercel env "Encrypted but pulls blank" — runbook

A real failure mode on Vercel where the dashboard shows a variable as
**Encrypted** (the standard tag for any secret-typed env var), but
`vercel env pull --environment=production .env.production.local`
writes the variable to the local file with an **empty value**. The
runtime then sees `process.env.VAR === ''` and any code that does
`if (!process.env.VAR) throw …` correctly refuses; less defensive
code silently misbehaves.

Discovered for `STRIPE_SECRET_KEY` during the 2026-06-02 HSB
production env activation check. Same shape can hit any secret-typed
var — `RESEND_WEBHOOK_SECRET`, `BLOB_READ_WRITE_TOKEN`, etc.

## How `scripts/check-production-env.mjs` reports it

```
❌ FAIL  STRIPE_SECRET_KEY              PRESENT_BUT_EMPTY      [required]
   observed: set to EMPTY STRING — classic "Encrypted in Vercel dashboard but pulls blank" pattern
   purpose:  Stripe Checkout / webhook handling. MUST be a live key on production.
   next:     Vercel "encrypted but pulls blank" pattern: the var is registered in the
             dashboard but the stored value is empty. Fix: vercel env rm STRIPE_SECRET_KEY
             production (removes the empty entry), then vercel env add STRIPE_SECRET_KEY
             production (pipe the value via stdin so it never appears in shell history),
             then vercel env pull --environment=production .env.production.local and
             re-run this checker.
```

The `PRESENT_BUT_EMPTY` status is the diagnostic: the variable IS in
the pulled `.env` file (so `Object.prototype.hasOwnProperty.call(process.env, NAME)`
returns true) but its value is `''` (empty string). That state never
happens by accident on a hand-typed `.env`; it's specifically how
Vercel surfaces a registered-but-valueless secret.

## Common causes

1. **Initial `vercel env add` was Ctrl-Ced or had an empty stdin.**
   Vercel registers the variable name but stores empty bytes.
2. **`vercel env add` was given a file whose contents were
   `<newline>` or `<just whitespace>`.** Vercel trims and stores
   empty.
3. **Secret was rotated by removing the value but not the entry.**
   Someone replaced the value with an empty string in the dashboard
   UI to "blank it out" instead of removing the entry.
4. **Copy-paste from a password manager that masked the value**
   (`••••••••••`) which the password manager passed as empty when
   "reveal" wasn't toggled.

## Safe remediation (no values printed)

Run these from a terminal where shell history is private (or prefixed
with a leading space if your shell honors HISTCONTROL=ignorespace):

```bash
# 1. Confirm the diagnosis. The script prints `PRESENT_BUT_EMPTY` and
#    "EMPTY STRING" in the observation line.
node --env-file=.env.production.local \
  scripts/check-production-env.mjs --env=production

# 2. Remove the broken entry from Vercel. Production scope only.
vercel env rm STRIPE_SECRET_KEY production
# Confirm: y

# 3. Re-add with the correct value via stdin. NEVER paste the value
#    as a positional CLI arg (would show in `ps` and history).
#    The two safe patterns:

#    a) Pipe from a password-manager CLI (preferred):
   op read "op://vault/HSB Prod/STRIPE_SECRET_KEY" \
     | vercel env add STRIPE_SECRET_KEY production

#    b) Pipe from a file you immediately shred:
   pbpaste > /tmp/.secret.$$ && \
     vercel env add STRIPE_SECRET_KEY production < /tmp/.secret.$$ && \
     shred -u /tmp/.secret.$$ 2>/dev/null || rm -P /tmp/.secret.$$

# 4. Re-pull and re-verify.
rm -f .env.production.local
vercel env pull --environment=production .env.production.local
node --env-file=.env.production.local \
  scripts/check-production-env.mjs --env=production
```

Expected outcome after step 4: the variable shows `✅ OK` /
`PRESENT` with a shape observation like `starts with 'sk_live_',
length 107`.

## Hard rules

- **Never** print the secret value into a terminal, log file,
  Slack message, ticket comment, or commit message. The runbook
  procedure above uses stdin pipes for exactly this reason.
- **Never** re-add a secret as a positional CLI argument
  (`vercel env add NAME VALUE production`) — Vercel does accept this
  form but it puts the value in the running process's argv and your
  shell history.
- **Do not delete `.env.production.local`** with the value still in
  it visible in a terminal: prefer `rm -P` or `shred -u`.
- **Verify the shape** after re-pull. A wrong-prefix value (e.g., a
  test key pasted in place of a live key) is a separate `SHAPE_FAIL`
  and needs a different fix.

## Verification

The env checker's `PRESENT_BUT_EMPTY` failure must clear before
re-deploying. The `--json` output's `verdict` field must read
`"PASS"`:

```bash
node --env-file=.env.production.local \
  scripts/check-production-env.mjs --env=production --json \
  | jq -r '.verdict'
# Expected: PASS
```

## What the script does NOT do

- It does not contact Vercel's API.
- It does not modify any env var, anywhere.
- It does not echo any secret value.
- It does not deploy.

The remediation steps above are operator actions, not automation.

## Companion docs

- `docs/ops/hsb-production-env-activation-checklist-2026-06-02.md` —
  the full activation checklist this runbook supports.
- `docs/ops/hsb-resend-bounce-monitoring-2026-06-02.md` — covers
  `RESEND_WEBHOOK_SECRET` specifically (same failure mode applies
  there).
