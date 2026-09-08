---
"@molpha/sdk": minor
---

Protocol release: `sourceId` replaces `feedId`, request auth binds the gateway, new Solana program (`submit_attestation`).

**Breaking**

- `feedId` is gone. A round is identified by `sourceId = deriveSourceId(apiConfig)` (the former `deriveApiConfigHash`, now deprecated alias) — `deriveFeedId` / `deriveFeedIdString` are removed. `DataUpdateResult.feedId`, `NodeKeyVerifierArgs.feedId`, the EVM tuple label and the Starknet `feed_id` field are renamed to `sourceId` / `source_id`; the EVM ABI component `jobId` is now `sourceId` (encoding unchanged).
- `MolphaGateway.requestSignedData` no longer takes `feedId` (it derives `sourceId` from `apiConfig`) and `prepareContext()` takes no argument. `MolphaSDK.requestAndSubmit(opts)` drops the positional feed id.
- Gateway request auth is now `keccak256("MOLPHA_REQAUTH_V1" || programId || gatewayPda || sourceId || u8(signaturesRequired) || u64le(timestamp))` (`hashRequestAuth`); `authMessage` is removed. Because the hash binds each gateway's on-chain account, endpoints accept `{ url, gatewayAuthority }`; when the authority is omitted the SDK fetches it from `GET /v1/info`. The auth signature is computed per endpoint tried.
- Solana client targets program `MoLFnEbuMS5gWnXNfUMLAYSqRM3eQZKWRzjeMQfqbT3`: `submitDataUpdate` → `submitAttestation` (deprecated alias kept, returns the feed PDA), `readFeed(sourceId, signaturesRequired, submitter?)` (feeds are keyed per submitter), registry reads use the version-addressed zero-copy `Registry` (`getRegistrySelectionConfig` now returns `nodeCount`), signer accounts resolve from `registry.nodes[bit]` (`VIRTUAL_INDEX` and previous-version remapping removed), `nodePda(owner)`, `subscribe`/`extendSubscription` use the ATA treasury, `PlanInfo.maxRounds` added.

**Added**

- `attestationMessageHash` / `attestationMessageHashFromResult` (`MESSAGE_PREFIX = keccak256("MOLPHA_MESSAGE_V1")`), `MOLPHA_PROGRAM_ID`, `registryPda`, `gatewayPda`, `deriveGatewayPda`, `MolphaGateway.fetchGatewayInfo`, `MolphaSolanaClient.readRegistry`.
- Selection size follows the on-chain `nodeCount`; the node list is only fetched when a round needs it.
