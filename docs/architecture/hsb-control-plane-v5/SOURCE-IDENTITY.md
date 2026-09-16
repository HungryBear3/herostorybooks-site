# HSB Control-Plane V5 Source Identity

This directory vendors the accepted offline contract used to implement the Phase B control-plane foundation.

- Application base commit: `957a720a0635e2d875d6ecfb989b6bc5c1092c88`
- Application base tree: `087d10b03ebf5918dc9d767232dc998722ce4fcd`
- Source candidate manifest SHA-256: `de6e3f9d654309a648d1932eacae98c058d9f905121ac9aaf1d576514ddc1015`
- Source candidate entries: `27`
- Canonical registry SHA-256: `964695a89f250b07ef0bcb0a6b15deee9e33af6036c1a0bc0650d2d5bd014fa0`
- Independent verdict: `PASS_FINAL_OFFLINE`

## Vendored byte identities

```text
f97a15c0c9fef6319f4322a6539bbce206b8e59df09d3f62f3ae08b784c9fb99  hsb-checkout-control-v4.json
fa8cb423b6a766e52f989b47de67111c087d42a4da56ee242c19076792f7075b  schema/hsb-checkout-control.schema.json
5ed6ee555711bb687e9b4e50dd3bd0077fabd4010e7e84862f4fc06f065c2b32  generated/HSB-ARCHITECTURE-DECISION-V4.md
d7ba09f81850ce67a506b24c92d3334128f6020eb3bb7b7e79935b39b7343d7c  generated/HSB-PHASE-B-CONTRACT-V4.md
de6e3f9d654309a648d1932eacae98c058d9f905121ac9aaf1d576514ddc1015  evidence/SOURCE-CANDIDATE-FILES.sha256
775c652de61042d4e0abf706fe7c2ad0e2ee6ff2244498ac5b44a8124fd5eafc  evidence/FINAL-OFFLINE-VERDICT.md
```

These files are implementation inputs, not runtime authorization. The initial implementation must remain default-off and unreachable from existing checkout, payment, webhook, fulfillment, email, print, and provider paths.
