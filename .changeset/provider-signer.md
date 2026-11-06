---
"@molpha/sdk": minor
---

Provider signers, and `submit_attestation` without signer accounts (program `dev`, `333b5c9`).

**Breaking**

- `submit_attestation` takes no signer accounts: the program reads each signer's key from the
  registry snapshot's record for its bit and refuses remaining accounts
  (`UnexpectedSignerAccounts`). `MolphaSolanaClient.submitAttestation` / `submitAttestations` pass
  none and sum the coalition key from the snapshot's record keys, so they read no `Node` account.
  After a key rotation the record key is the one the version names, which can differ from the
  `Node` account's current key.
- `resolveRemainingAccounts` is replaced by `resolveSignerKeys(signersBitmap, registry)`, which
  returns the signers' record keys in bit order. `RegistryView` gains `nodeKeys` and
  `providerKeys` (`null` for a hole), and `registrySignerKey` reads one.
- A `Registry` snapshot is a header (`node_count` and `provider_count`, a byte each) and two record
  tables: the node slots, then the provider slots (provider slot `p` signs at bit `64 + p`; slot 0
  is reserved). `RegistryView` has `providerCount` and `providers`, and `registrySigner(registry,
  bit)` resolves either table. The registry read checks the account's owner and discriminator.
- Committee selection draws over node slots only: provider records are never drawn, and a live-slot
  list naming a slot at or above 64 is refused. This changes the draw for a registry whose
  `node_count` reached past 64 in the previous single-table layout (`selection_holes.vectors`
  follows the verifier's).
- `estimateSubmitTransactionSize` / `maxAttestationsPerTransaction` no longer count signer
  accounts: three attestations fit in a transaction whatever the signer count. `distinctSigners` is
  accepted and ignored.
- `RegistryInfo` (the gateway's `GET /v1/nodes` registry) matches the gateway: `nodeCount` is the
  number of live nodes and the new `slotCount` the slot count, holes included. `liveCount` is gone.
  `eligibleSetSize` reads `nodeCount` as the live count.
- The `dev` profile targets program `dzemhcTeUnUEhDcyUssWP8GfcMCYwKezVg4U1hvdEJe` (what
  `https://dev-gateway.molpha.io/` runs against) with its IDL: provider instructions and accounts,
  `rotate_node_key`, `extend_registry`, `RegistryState.next_provider_id`.

**Added**

- `requireProvider` on `requestSignedData` asks for a round the source's provider signer also
  signs. The source must name the provider in its `provenance` block. The provider counts toward
  `signaturesRequired`, so the round is `signaturesRequired - 1` nodes plus the provider: selection,
  the paid-source authorizations and the gateway quote use that node quorum. While the signer is
  down, or when it refuses the round, the gateway answers 503 and there is no committee-only
  fallback.
- `nodeQuorum(signaturesRequired, provider)`, `hasProviderBit`, `providerBitCount`, and a
  `requireProvider` argument on `deriveSelectionBitmap` and `eligibleSetSize`.
- `assertSignerCount` mirrors the program: at most one provider bit, at least `signaturesRequired`
  signers counting it, and at most `nodeQuorum + redundancyBuffer` node bits.
- Source `provenance: { provider }` block (validated, part of the canonical source).
