---
"@molpha/sdk": patch
---

Submit several attestations of one feed in one transaction.

**Added**

- `MolphaSolanaClient.submitAttestations(attestations, opts?)`: one transaction with a
  `submit_attestation` instruction per attestation, in timestamp order. Instructions run in the order
  they are listed, so all of them apply, oldest first, however other transactions are ordered on the
  way to the leader. Transactions sent milliseconds apart for one feed are overtaken by a newer one
  often enough to matter (about a third at 250 ms spacing in a devnet run), and the older one fails
  with `FeedNotNewer`. A batch spaces the transactions several times further apart and spends one
  fee for all of them. The transaction is atomic: if it fails, none of its attestations applies.
- `BatchTooLargeError` (a `RangeError`): thrown, with nothing sent, when the attestations do not fit
  in a 1232 byte transaction. `fits` says how many do, oldest first.
- `estimateSubmitBatchComputeUnits`, `estimateSubmitTransactionSize`, `maxAttestationsPerTransaction`
  and `SUBMIT_INSTRUCTION_DATA_BYTES`, to plan a batch. With three signers three attestations fit; with
  four or five only two; a priority-fee instruction can cost one when the signer sets differ.

`submitAttestation` is unchanged; it now shares its preparation with the batch path.
