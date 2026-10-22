# @molpha/sdk

## 0.2.0

### Minor Changes

- 72ecf35: Bake distinct deployment defaults per npm channel at build time.

  **Added**

  - `config/deployments.json` and `idl/profiles/{stable,dev}/` — selected by `MOLPHA_SDK_PROFILE` via `scripts/select-profile.ts` before build/test.
  - `MOLPHA_SDK_PROFILE` and `MOLPHA_DEV_VERIFIERS_PROVISIONAL` exports so consumers can see which defaults were baked in.

  **Fixed**

  - `@molpha/sdk@latest` (`stable`) now defaults to `https://gateway.molpha.io/` and the Brebeneskul program `MoLFGDp…` instead of the shared dev-gateway URL.
  - `@molpha/sdk@dev` defaults to `https://dev-gateway.molpha.io/` and program `chivcFQ…`. EVM/Starknet addresses stay provisional (stable fallback) until the Attestation-interface redeploy fills the manifest.

- 766681b: Match the epoch-settlement Solana program (`molpha-solana-program` `3d01170`) and add median tolerance mode.

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

- e642657: EVM helpers target the current Molpha EVM verifier (`molpha-core-contracts` #23 and the selection
  patch), `verify(Attestation attestation, uint64 maxAge) returns (bool success, uint8 code)`.
  `MOLPHA_VERIFIER_ADDRESS` is unchanged and will be updated with the redeploy.

  **Breaking**

  - `MOLPHA_VERIFIER_ABI` describes `verify(Attestation, uint64) -> (bool, uint8)` in place of
    `verify(DataUpdate, SchnorrSignature) -> bool`.
  - `buildEvmVerifierArgs(result, { maxAge })` now returns `{ attestation, maxAge }`, where
    `attestation` is the nested `{ payload, signature }` object with Solidity member names and viem
    primitive types, ready for `readContract` or an ethers `Contract`. `maxAge` is required: `0`
    disables the verifier's freshness check, which a stateless verifier should not do silently.
  - `EvmDataUpdateTuple` / `EvmSchnorrSignatureTuple` are replaced by `EvmAttestationPayload` /
    `EvmSchnorrSignature` / `EvmAttestation`. Payload members follow ABI order (`value`, `sourceId`,
    `registryVersion`, `signaturesRequired`, `timestamp`), `signaturesRequired` is `uint8`
    and `timestamp` is a `bigint`.
  - The builder range-checks every integer against its Solidity type and throws `RangeError`
    instead of producing calldata the ABI decoder would revert on.

  **Added**

  - `encodeEvmVerifyCalldata(args)` — calldata for a raw `eth_call`, pinned against Foundry's
    encoding of the contract's own attestation fixture.
  - `parseEvmVerifyResult(returned)` — decodes `(bool, uint8)` from raw return data or a decoded
    viem/ethers tuple into `{ success, code, reason }`.
  - `MOLPHA_VERIFIER_ABI` now includes every read-only registry view (`getTotalNodes`,
    `redundancyBuffer`, `getRegistryRoot`, `getRegistryPointer`, `activatesAt`, `retiredAt`,
    `isLatestVersion`, `nodeStatus`, `isNode`) and the `InvalidRegistryVersion` error.
  - `u8` encoding helper.

  **Fixed**

  - `attestationMessageHash` / `attestationMessageHashFromResult` now hash
    `value ‖ sourceId ‖ u32 registryVersion ‖ u8 signaturesRequired ‖ u64 timestamp ‖ signersBitmap`,
    the preimage the node signer produces and the EVM, Solana and Starknet verifiers check. The
    previous layout matched no current verifier. `signaturesRequired` outside `0..255` now throws
    instead of wrapping.

- c981c69: Support API sources that are themselves x402-paywalled, matching the gateway's paid-source release.

  **New**

  - `requestSignedData({ sourcePayment: { signer } })` pays a paywalled source directly from the caller's own wallet. The SDK reads the source's own 402, signs one EIP-3009 transfer authorization per node in the round's eligible set (`min(signaturesRequired + redundancyBuffer, nodeCount)`), and sends them as `sourcePayments`. Payment goes to the source, never to Molpha, and the round still costs exactly one round of subscription quota.
  - `UpstreamPaymentRequiredError` — thrown, with the gateway's `quote`, when a source is paywalled and no `sourcePayment` was supplied. Terminal: such a round is never retried blindly.
  - `probeSource`, `signSourcePayments`, `eligibleSetSize`, `parseUpstreamQuote` for x402-native agents driving `/v1/x402/execute` with their own client.
  - `createEvmSignerFromPrivateKey`, `evmAddressFromPrivateKey`, and EIP-712/EIP-3009 primitives (`transferWithAuthorizationDigest`, `domainSeparator`, `toChecksumAddress`). Isomorphic — no `Buffer`, so browser bundles are unaffected.
  - `gateway.getNodesInfo()` returns the peer set plus the gateway's advisory `registry` policy (`version`, `nodeCount`, `redundancyBuffer`) now reported by `GET /v1/nodes`. The on-chain read stays authoritative for `requestSignedData`.
  - `bytesToBase64` / `base64ToBytes` encoding helpers.

  Beta signs `exact` payments in USDC on Base and Base Sepolia only; any other network or asset is rejected before anything is signed.

- 766681b: Remove compatibility aliases: `deriveApiConfigHash`, `submitDataUpdate`, `nodeWalletFromFile`, `keypairFileSigner`, `DataUpdateResult`, and `attestationMessageHashFromResult`. Use `deriveSourceId`, `submitAttestation`, `walletFromKeypairFile`, `Attestation` / `AttestationPayload`, and `attestationMessageHashFromAttestation` instead.

  `Attestation` nests signed fields under `payload` and `signature` (replacing flat `valuePacked`, `timestamp`, and top-level signature fields). Gateway `value` remains the human-readable decode.

- e642657: Align the Solana client and vendored IDL with the latest Molpha program.

  **Breaking**

  - `SubscriptionInfo` no longer exposes the removed on-chain `prepaidUsdc` and `price` fields.
  - `SubmitAttestationArgs` now matches the program's nested `{ attestation, rawValue }` layout.

  **Added**

  - `submitAttestation` accepts an optional `rawValue` preimage, validate its
    size and keccak digest client-side, and submit it using the program's hashed-value flow.
  - `FeedAccount.submitter` reflects the submitter now stored in the on-chain feed account.

- 81c88bd: Protocol release: `sourceId` replaces `feedId`, request auth binds the gateway, new Solana program (`submit_attestation`).

  **Breaking**

  - `feedId` is gone. A round is identified by `sourceId = deriveSourceId(apiConfig)` — `deriveFeedId` / `deriveFeedIdString` are removed. `DataUpdateResult.feedId`, `NodeKeyVerifierArgs.feedId`, the EVM tuple label and the Starknet `feed_id` field are renamed to `sourceId` / `source_id`; the EVM ABI component `jobId` is now `sourceId` (encoding unchanged).
  - `MolphaGateway.requestSignedData` no longer takes `feedId` (it derives `sourceId` from `apiConfig`) and `prepareContext()` takes no argument. `MolphaSDK.requestAndSubmit(opts)` drops the positional feed id.
  - Gateway request auth is now `keccak256("MOLPHA_REQAUTH_V1" || programId || gatewayPda || sourceId || u8(signaturesRequired) || u64le(timestamp))` (`hashRequestAuth`); `authMessage` is removed. Because the hash binds each gateway's on-chain account, endpoints accept `{ url, gatewayAuthority }`; when the authority is omitted the SDK fetches it from `GET /v1/info`. The auth signature is computed per endpoint tried.
  - Solana client targets program `MoLFnEbuMS5gWnXNfUMLAYSqRM3eQZKWRzjeMQfqbT3`: `submitAttestation` (returns the feed PDA), `readFeed(sourceId, signaturesRequired, submitter?)` (feeds are keyed per submitter), registry reads use the version-addressed zero-copy `Registry` (`getRegistrySelectionConfig` now returns `nodeCount`), signer accounts resolve from `registry.nodes[bit]` (`VIRTUAL_INDEX` and previous-version remapping removed), `nodePda(owner)`, `subscribe`/`extendSubscription` use the ATA treasury, `PlanInfo.maxRounds` added.

  **Added**

  - `attestationMessageHash` / `attestationMessageHashFromResult` (`MESSAGE_PREFIX = keccak256("MOLPHA_MESSAGE_V1")`), `MOLPHA_PROGRAM_ID`, `registryPda`, `gatewayPda`, `deriveGatewayPda`, `MolphaGateway.fetchGatewayInfo`, `MolphaSolanaClient.readRegistry`.
  - Selection size follows the on-chain `nodeCount`; the node list is only fetched when a round needs it.

- 06fea9e: Starknet helpers target the cross-VM parity release of the Molpha Starknet verifier,
  `verify(attestation: Attestation, max_age: u64) -> (bool, u8)`.

  **Breaking**

  - `buildStarknetVerifierArgs(result, { maxAge })` now returns `{ attestation, maxAge }`, where
    `attestation` is the nested Cairo `Attestation { payload, signature }`. `maxAge` is required:
    `0` disables the verifier's freshness check, which a stateless verifier should not do silently.
  - `StarknetDataUpdate` is replaced by `StarknetAttestationPayload`, with members in Cairo `Serde`
    order (`value`, `source_id`, `registry_version`, `signatures_required`, `timestamp`)
    and `signatures_required` narrowed to `u8`. `StarknetVerifierArgs` changes shape accordingly.
  - The builder now range-checks every integer against its Cairo type and throws `RangeError`
    instead of producing calldata that would revert during deserialization.

  **Added**

  - `encodeStarknetVerifyCalldata(args)` — the 13-felt calldata for a raw `starknet_call`, pinned
    against the Cairo verifier using the EVM golden vector.
  - `parseStarknetVerifyResult(response)` — decodes `(bool, u8)` from a raw call or an ABI-aware
    client into `{ success, code, reason }`.
  - `VERIFY_CODES`, `VerifyCode`, `VerifyCodeName`, `verifyCodeName` — the verifier result codes
    shared across the EVM and Starknet verifier contracts.

- 1aa926e: Gateway-assigned millisecond timestamp.

  **Breaking**

  - `timestamp` is unix **milliseconds** and is the gateway's clock, floored to the 100 ms round tick,
    at the moment it stamps the round; the caller never chooses it. The request body carries no round
    timestamp. `requestSignedData` takes `timestamp`, the signers' bitmap and the rest of the signed
    fields from the response and refuses a response that lacks any of them. The response is the gateway's nested
    `{ status, data: { attestation: { payload, signature }, value, fresh } }` shape only.
  - `deriveSelectionSeed` hashes the one-second window index, `timestamp / 1000`
    (`SELECTION_WINDOW_MS`), under `MOLPHA_SELECTION_V1`; committees follow the timestamp's second.
    `deriveSelectionBitmap`'s `ts` is in milliseconds.
  - A retry is a new round: the gateway stamps it anew.
  - Private API secrets are encrypted for every registry node (the committee is unknown until the
    gateway has stamped the round); the gateway forwards only the selected nodes' envelopes.
    `NodeKeyVerifierArgs` is `{ sourceId, registryVersion, nodeIndexes, nodes }` and covers all of them.
  - EVM/Starknet helpers pass `timestamp` through in milliseconds; `maxAge` stays in seconds.
  - `GET /v1/nodes` and `GET /v1/info` payloads must be in the gateway's `{ status, data }` envelope.

  **RequestAuth**

  - Gateway requests are authorized by `RequestAuth`: the subscription owner or a delegate signs
    `keccak256("MOLPHA_REQAUTH_V1" || programId || gatewayPda || sourceId || u8(signaturesRequired) || u64le(authTimestamp))`
    and the body carries `authSig` and `authTimestamp`. `authTimestamp` is unix **seconds** from the
    SDK clock, read fresh for every attempt and endpoint; it is a freshness stamp for the
    authorization only and is not part of the round. `hashRequestAuth` takes `authTimestamp`.
  - The `signer` / `defaultSigner` options, `MolphaWallet.signAuthMessage`, `gatewaySignerFromWallet`
    and `signerFromKeypair` sign it.

  **Added**

  - `timestampSeconds` and `timestampAgeSeconds` for comparing the timestamp with
    chain clocks (Solana `Clock`, EVM `block.timestamp`, epochs, `maxAge`), which are in seconds.

### Patch Changes

- 9bcac99: Submit several attestations of one feed in one transaction.

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

## 0.1.0

### Minor Changes

- cd8ad49: Rename package to `@molpha/sdk`.
