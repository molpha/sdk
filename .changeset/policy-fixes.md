---
"@molpha/sdk": patch
---

Policy engine fixes from the 2026-11-24 validation:

- `readOutcome` returns `null` for a value that is not one 32-byte word.
- `simulateSource` checks that the gateway's answer is about the source that was sent (its `sourceId`), and returns the `timestampMs` it evaluated at.
- `distinctHosts` treats a host with a trailing dot as the same host (`api.example.com.` is `api.example.com`), as nodes do.
