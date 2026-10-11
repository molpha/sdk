---
"@molpha/sdk": minor
---

Match the epoch-settlement Solana program (`molpha-solana-program` `3d01170`) and add median tolerance mode.

**Breaking**

- The vendored IDL (`MOLPHA_IDL`) is regenerated for `3d01170`. Round-settlement, bond and punish instructions are gone; epoch / ticket instructions are added; `Subscription` and `Delegate` lose their usage fields; `Node.owner` is `Node.authority`; `Registry` gains `active_from`; `add_plan` / `update_plan` take `config: PlanConfig`.
- `SubscriptionInfo.usedRounds`, `prepaidUsdc` and `price` are removed. The program no longer stores them: round quota is counted by the gateway's off-chain outbox, so there is no on-chain "rounds used" figure to read or poll. `SubscriptionInfo` is now `{ owner, planType, validUntil, maxRounds, delegateCount, maxDelegates, maxSigners }`.
- `submit_attestation` arguments changed to `{ attestation: { payload, signature }, rawValue, coalitionKey }`. `buildSubmitAttestationArgs(result, coalitionKey, rawValue?)` now requires the coalition key. `MolphaSolanaClient.submitAttestation` computes it by fetching the signer `Node` accounts (one batched read); pass `{ coalitionKey }` to skip that fetch, or `{ rawValue }` for values longer than 32 bytes. It also rejects signer counts outside `[signaturesRequired, signaturesRequired + redundancyBuffer]` before sending.
- `FeedAccount` gains `submitter` and its `value` is always 32 bytes; `RegistryView` gains `activeFrom`; `nodePda(owner)` is `nodePda(authority)` (same seeds).
- `attestationMessageHash` follows the cross-VM encoding: `value || sourceId || u32be(registryVersion) || u8(signaturesRequired) || u64be(timestamp) || signersBitmap` (141 bytes), pinned against the Rust and Go golden vector.
- `canonicalizeAPIConfig` / `deriveSourceId` throw `AggregationConfigError` for an invalid `aggregation` (including `mode: "exact"`). A gateway response whose `configHash` differs from the derived `sourceId` is rejected, as is one whose echoed `aggregation` differs from the request (or appears on an exact request).

**Added**

- Median tolerance mode: optional `APIConfig.aggregation` (`{ mode: "tolerance", rule: "median", maxDeviationBps, maxAgeMs, numeric: { type: "int256", decimals } }`). It is part of the `sourceId` and omitted for exact mode, so existing configs keep their ids. Only `median` / `int256` are supported, `signaturesRequired >= 3` is enforced client-side, and the nested object is rebuilt in canonical key order. Flows through the gateway request body, private-API encryption and `MolphaSDK.requestAndSubmit`. Known-answer `sourceId` pinned against the node's `TestAggregationSourceIdentity`.
- For tolerance results `DataUpdateResult.value` is rendered from the signed `valuePacked` at the source's `decimals`, and the signed response fields (`valuePacked`, `signersBitmap`, `s`, `commitmentAddr`) are required.
- Signed-`int256` helpers mirroring the node's `new/tolerance`: `encodeInt256Decimal`, `encodeInt256`, `decodeInt256`, `formatInt256Decimal`, `INT256_MIN`, `INT256_MAX`.
- `computeCoalitionKey(keys)` — the affine secp256k1 sum of the signers' public keys, pinned against the Rust verifier (`molpha_verifier::coalition_key`) on the 12-node fixture.
- Exports `AggregationConfig`, `NumericConfig`, `AggregationConfigError`, `canonicalizeAggregation`, `assertAggregationQuorum`, `MIN_TOLERANCE_SIGNATURES`, `CoalitionKey`, `Secp256k1KeyInput`, `SubmitAttestationArgs` (and its payload / signature parts).

Not covered: epoch settlement itself (`submit_ticket`, sweeps), which the gateway and the program CLI drive, and an end-to-end run against a live validator, gateway and nodes. Tolerance requests need a gateway and nodes that forward and honour `aggregation`; this was checked against the sources in the workspace, not a running deployment.
