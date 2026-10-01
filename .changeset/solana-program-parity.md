---
"@molpha/sdk": minor
---

Align the Solana client and vendored IDL with the latest Molpha program.

**Breaking**

- `SubscriptionInfo` no longer exposes the removed on-chain `prepaidUsdc` and `price` fields.
- `SubmitAttestationArgs` now matches the program's nested `{ attestation, rawValue }` layout.

**Added**

- `submitAttestation` accepts an optional `rawValue` preimage, validate its
  size and keccak digest client-side, and submit it using the program's hashed-value flow.
- `FeedAccount.submitter` reflects the submitter now stored in the on-chain feed account.
