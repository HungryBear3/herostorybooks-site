# Pinned decision-packet validator (test fixture — do not edit)

`decision_packet/` holds the validation subset of the offline analytics
decision packet exactly as committed at
`d64d095f361dc10b939289a8787f25dc6d5d925c`: `__init__.py`, `errors.py`,
`evidence.py`, `identifiers.py`, `jsonio.py`, `naming.py`, `schemas.py`,
`vocab.py`, byte for byte (`git show <commit>:decision_packet/<file>`).

It is test-only and never runs in the app. `tests/decision-packet-compat.test.ts`
checks every file against the SHA-256 pinned in
`src/lib/decision-packet-contract.ts`, reads the packet's vocabularies back out
of it, and runs its `load_evidence` validation (what the packet's `validate`
command runs) on HSB's packet exports, using `python3 -I -B` so nothing is
read from the environment or written here.

To re-pin: copy the same files from the new packet commit, update the hashes
and commit in `src/lib/decision-packet-contract.ts`, the mapping contract's
`target.reference_commit`, and the tests; then review every vocabulary change.
