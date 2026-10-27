---
"@molpha/sdk": minor
---

Stable registry slots; committee selection is not part of verification.

**Breaking**

- A removed node leaves a hole in the registry snapshot instead of the last node taking its place:
  every other node keeps the signer bit it signs with, and a new registration takes the lowest
  hole. `RegistryView.nodes` is `Array<Address | null>` (`null` is a hole) and `nodeCount` is the
  slot count, holes included. `resolveRemainingAccounts` and `verifyNodeKeysForPrivateApi` refuse a
  bit that names a hole.
- The committee is drawn over the live members: `deriveSelectionBitmap(..., liveSlots?)` draws
  `min(signaturesRequired + redundancyBuffer, live members)` ranks and maps rank `r` to slot
  `liveSlots[r]`. Without holes the result is unchanged. `RegistrySelectionConfig.liveSlots` and
  `MolphaSolanaClient.getRegistrySelectionConfig()` carry the live slots; a private-API round
  encrypts for the live slots, not `0..nodeCount`.
- Verifiers no longer require `signers ⊆ selection`; any quorum of live nodes verifies. The
  `BAD_QUORUM` code now means a set signer bit names no live node (past the last slot or on a hole).
- The EVM verifier ABI drops `redundancyBuffer()`; the contract has no redundancy buffer.
- `MolphaSolanaClient` reads a registry snapshot in the current layout (header plus one record per
  slot) directly; the vendored IDL still describes the previous fixed layout and is used only for
  a snapshot in that layout.

**Added**

- `mapRanksToSlots`, `decodeRegistryAccount`, `liveSlots`.
