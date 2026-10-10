# @molpha/sdk

[![npm](https://img.shields.io/npm/v/@molpha/sdk)](https://www.npmjs.com/package/@molpha/sdk)
[![license](https://img.shields.io/npm/l/@molpha/sdk)](./LICENSE)

TypeScript SDK for **[Molpha](https://molpha.io)**, a pull-based oracle protocol. Molpha nodes
fetch an API result, sign it once with a threshold signature, and the same signed attestation can be
verified on **Solana, EVM and Starknet**. This SDK is for data consumers and feed owners, and runs in
the browser and in Node.js.

Links: [molpha.io](https://molpha.io) · [GitHub](https://github.com/Molpha/sdk) · [npm](https://www.npmjs.com/package/@molpha/sdk)

Use it to:

- subscribe to a Molpha plan on Solana;
- derive a source id from an API config;
- request a threshold-signed attestation from the gateway;
- submit the signed result on-chain (`submit_attestation`);
- verify/read the latest feed value;
- build EVM and Starknet verifier arguments from the same signed result.

**Runtime:** Node.js `>=20.19.0` (ESM).

## Protocol model

Molpha turns off-chain API responses into verified on-chain data.

At a high level:

```text
Consumer
  └─ subscribes (USDC) on Solana
  └─ derives sourceId = keccak256(canonical apiConfig)
  └─ signs a RequestAuth bound to (programId, gateway, sourceId, signaturesRequired, authTimestamp)

Gateway
  └─ assigns the round's timestamp (unix ms) from its own clock and coordinates a signing round

Verifier nodes
  └─ fetch/recompute the API result independently
  └─ sign the canonical result if valid

Solana / EVM / Starknet verifiers
  └─ verify quorum, registry version, signer bitmap, timestamp, and aggregate signature
  └─ finalize or expose the verified value
```

The gateway is a coordination layer, not a trusted oracle. A result is trusted only if it carries a valid threshold signature from the selected verifier nodes for the current registry version.

Molpha uses Solana as the canonical protocol chain for subscriptions, registry snapshots, node accounts, and feed state. EVM and Starknet verifier contracts are stateless verification surfaces: they verify signed Molpha attestations without managing subscriptions or source configuration locally.

Every signed attestation commits to the same message across chains:

```text
message = keccak256(
  keccak256("MOLPHA_MESSAGE_V1") || value || sourceId || u32be(registryVersion) ||
  u8(signaturesRequired) || u64be(timestamp) || signersBitmap
)
```

The preimage is 141 bytes (32 + 32 + 32 + 4 + 1 + 8 + 32).

`attestationMessageHash` / `attestationMessageHashFromAttestation` recompute it client-side.

## Install

```bash
npm install @molpha/sdk @anchor-lang/core bn.js
# or: pnpm add @molpha/sdk @anchor-lang/core bn.js
# or: yarn add @molpha/sdk @anchor-lang/core bn.js
```

`@anchor-lang/core` and `bn.js` are optional peer dependencies. Install them if you use the Solana / Anchor path (as in the examples below). Gateway-only or EVM/Starknet-only apps can skip them. Runtime dependencies installed automatically are `@solana/kit`, `@noble/*` and `canonicalize`.

For the pre-release channel (the `dev` gateway and the matching dev Solana program; may change without notice):

```bash
npm install @molpha/sdk@dev
```

### npm tags and deployment defaults

Defaults are baked at publish time from `config/deployments.json` (`MOLPHA_SDK_PROFILE`). Override at runtime with `endpoints`, `programId`, and `idl`.

| npm dist-tag | Profile | Default gateway | Solana program | EVM / Starknet |
|---|---|---|---|---|
| `latest` | `stable` | `https://gateway.molpha.io/` | `MoLFGDpFoVnQgwbkTNScKPohCxhbfd61JjFrnotuwzh` | Documented CREATE2 / Sepolia addresses |
| `dev` | `dev` | `https://dev-gateway.molpha.io/` | `chivcFQgxzwkpLvW41PV431HQ4dYpaW3povQH3AdpQt` | Provisional until redeploy (`MOLPHA_DEV_VERIFIERS_PROVISIONAL`); falls back to stable addresses |

Inspect the active profile via `MOLPHA_SDK_PROFILE` and `MOLPHA_DEV_VERIFIERS_PROVISIONAL`. Local builds: `MOLPHA_SDK_PROFILE=stable pnpm build` or `MOLPHA_SDK_PROFILE=dev pnpm build` (default `dev`).

| Import | Use |
|---|---|
| `@molpha/sdk` | Facade (`MolphaSDK`), `MolphaGateway`, `MolphaSolanaClient`, core hashing (`deriveSourceId`, `attestationMessageHash`, `hashRequestAuth`, `timestampSeconds`), EVM/Starknet helpers. Browser-safe; no `fs` in the main entry. |
| `@molpha/sdk/utils` | `walletFromKeypairFile`, `loadKeypair` — load a Solana CLI keypair as an Anchor `Wallet`. Node.js only. |

The package is ESM with `"sideEffects": false`, so gateway-only or read-only apps can tree-shake unused paths.

## Quick start

```ts
import { web3 } from "@anchor-lang/core";
import { MolphaSDK, PlanType, deriveSourceIdString } from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const wallet = walletFromKeypairFile("~/.config/solana/id.json");
const sdk = new MolphaSDK({
  connection: new web3.Connection("https://api.devnet.solana.com", "confirmed"),
  wallet,
  // endpoints: [{ url: "https://gateway.example.com", gatewayAuthority: "<base58>" }],
});

// Subscribe if needed (USDC on Solana)
const plan = await sdk.solana.getPlan(PlanType.Basic);
await sdk.solana.subscribe(PlanType.Basic, {
  maxPriceUsdc: plan.subscriptionPrice,
});

const apiConfig = {
  url: "https://api.example.com/price",
  responseParser: "$.price",
};
const signaturesRequired = 3;

const { result, signature, feed } = await sdk.requestAndSubmit({
  apiConfig,
  signaturesRequired,
});

// The round's identity, for reads and cross-chain verification.
const sourceId = deriveSourceIdString(apiConfig); // === result.payload.sourceId
```

`requestAndSubmit` requests a threshold-signed attestation from the gateway (against the current on-chain registry version) and submits it to Solana via `submit_attestation` in one call. The first successful submit creates the feed account for `(sourceId, signaturesRequired, submitter)` if it does not already exist.

## Configuration

### Required

| Option | Description |
|---|---|
| `connection` | Anchor-compatible Solana RPC connection. |
| `wallet` | [`MolphaWallet`](#wallet). Used for Solana transactions and gateway authentication when available. |

### Optional

| Option | Default |
|---|---|
| `endpoints` | `DEFAULT_GATEWAY_ENDPOINT` — URL, `{ url, gatewayAuthority }`, or an array of either for failover (see [Gateway identity](#gateway-identity)) |
| `programId` | `MOLPHA_PROGRAM_ADDRESS` from the vendored IDL; also bound into gateway request auth |
| `idl` | `MOLPHA_IDL` from `idl/molpha.json` |
| `commitment` | `"confirmed"` |

```ts
import {
  DEFAULT_GATEWAY_ENDPOINT,
  MOLPHA_IDL,
  MOLPHA_PROGRAM_ADDRESS,
} from "@molpha/sdk";

const sdk = new MolphaSDK({
  connection,
  wallet,
  endpoints: [
    DEFAULT_GATEWAY_ENDPOINT,
    { url: "https://backup.example.com", gatewayAuthority: "<gateway base58 pubkey>" },
  ],
  // programId: "YourProgramAddress...",
  // idl: MOLPHA_IDL,
});
```

### Gateway identity

Gateway request authorization binds the gateway's on-chain account, so the client must know which gateway it is talking to:

```text
requestAuthHash = keccak256(
  "MOLPHA_REQAUTH_V1" || programId || gatewayPda || sourceId || u8(signaturesRequired) || u64le(authTimestamp)
)
gatewayPda = PDA(["molpha_gateway", gatewayAuthority], programId)
```

`authTimestamp` is the caller's unix **seconds** at signing: a freshness stamp for the authorization only (the gateway rejects stamps outside its `request_auth.window_seconds`, 60 s by default). It is read from the SDK clock for every attempt, so a retry after a 409 signs a fresh one. It has nothing to do with the round's `timestamp`.

Pass `gatewayAuthority` (the gateway's base58 signing pubkey) per endpoint to pin it. When omitted, the SDK calls `GET {url}/v1/info` once per endpoint and reads:

```json
{ "status": "ok", "data": { "gatewayAuthority": "<base58>", "programId": "<base58>" } }
```

A `programId` that differs from the client's is rejected. Because the hash differs per gateway, the auth signature is recomputed for every endpoint actually tried during failover — with a browser wallet that means one signing prompt per endpoint tried. `/v1/info` is never contacted when no signer is configured (dev zero-signature path).

### Round timestamp

The request body carries `authSig` and `authTimestamp` but no round timestamp. The gateway stamps the
round with its own clock, in unix **milliseconds**, floored to a fixed 100 ms tick
(`floor(nowMs / 100) * 100`), and the result carries the stamp in `payload.timestamp`. The tick is a
protocol constant, exported as `ROUND_TICK_MS`: it is the same on every gateway and node, it is not
configurable, and `GET /v1/info` does not report it. Stamping does not wait for a tick boundary, so
it adds no latency. Committee selection reads only the timestamp's one-second window (ten ticks), so
nobody can pick a committee by picking a time.

- One feed (a source, a quorum and a registry version) runs at most 10 rounds per second, whatever
  the request rate.
- Requests for the same feed inside one tick share one round: the nodes run it once and every caller
  gets the result. Each caller still spends its own unit of round quota, or its own payment.
- One consumer gets one round per tick per feed, so at most 10 per second. A second request by the
  same consumer for the same source and quorum inside the tick is refused with HTTP 409; the SDK
  retries it after one tick.
- The message the nodes sign is `keccak256(MOLPHA_MESSAGE_V1 || value || sourceId || u32be(registryVersion) || u8(quorum) || u64be(timestamp) || signersBitmap)`.
- Chain clocks, epochs and `maxAge`/staleness are in **seconds**: compare with
  `timestampSeconds(payload.timestamp)` (floored `ts / 1000`). `timestampAgeSeconds(ts, nowSeconds)` saturates at 0.
- The SDK returns `payload.timestamp` exactly as the gateway gave it. Nodes enforce the grid when
  they sign; the on-chain verifiers do not check it.

### Retries and timeouts

`requestSignedData` makes up to `maxRetries` attempts (default 6) and chooses the wait before each by why the last one failed (`retryDelayMs`). Every wait carries jitter so clients that failed together do not retry together. The backoff step is a capped exponential: 250 ms, 500 ms, up to 5 s.

| Last attempt | Wait before the next |
| --- | --- |
| 409 (this consumer already has a round for the source and quorum in the current tick) | one tick (`ROUND_TICK_MS`, 100 ms), plus up to 20 ms |
| 503 or 429 (gateway at capacity, or too few nodes accepted the round) | the later of the gateway's `Retry-After` and the backoff step, plus up to one more step |
| timeout, network error, other 5xx | the backoff step, half of it randomized |
| 400, 401, 402, 403 | none: terminal. 403 means the subscription is inactive or its round quota for the term is spent |

A 400 saying the `registryVersion` is not the current one (a cached context, or a registry roll between your read and the request) is the exception: the SDK reads the registry afresh and retries once, without spending an attempt.

The wait after a 409 is a full tick rather than the time left to the next boundary: a full tick puts the retry in a later tick whatever the offset between the client's clock and the gateway's, so the SDK never computes a boundary from the local clock. A caller polling one feed gains nothing by asking more often than once per tick: space the requests at least `ROUND_TICK_MS` apart.

A retry is a new request, and the gateway stamps it anew, so it is a **new round**: it spends another unit of round quota or needs another payment, and with a paywalled source another set of payment authorizations. Nothing ties a retry to the attempt before it; there is no idempotency key. Set `maxRetries: 1` to make a single attempt and decide about a retry yourself.

The gateway limits the total load: at capacity it answers HTTP 503 with a `Retry-After`, and a consumer over its request rate gets HTTP 429. It also answers 503 when too few nodes accept a round. The SDK treats them alike: it backs off and retries, and throws a `GatewayError` with the status when the attempts run out.

`timeoutMs` defaults to 35 s, above the gateway's own wait for a round (`roundTimeoutSeconds` in `/v1/info`, 30 s by default). A shorter timeout abandons a round the gateway is still running, and the retry then starts another. A source that cannot be fetched is reported as soon as enough nodes have failed (usually well under a second), not after the wait.

## Wallet

`wallet` is a single `MolphaWallet` used across both protocol surfaces:

| Layer | What it signs |
|---|---|
| Solana client | Transactions such as `subscribe`, `extendSubscription`, `submitAttestation` |
| Gateway client | `hashRequestAuth({ programId, gateway, sourceId, signaturesRequired, authTimestamp })` for authenticated gateway requests |

Gateway auth is resolved automatically when you use `MolphaSDK`:

1. Use `wallet.signAuthMessage` if provided.
2. Else derive signing from Anchor `Wallet.payer` when the secret key is available, such as with `walletFromKeypairFile`.
3. Else omit auth and use an all-zero `authSig`.

`MolphaSDK` passes the resolved signer to `sdk.gateway` as its default, so
`sdk.gateway.requestSignedData({ apiConfig, signaturesRequired })` authenticates without an
explicit `signer`. Standalone `new MolphaGateway(...)` omits auth unless you pass
a `defaultSigner` (third constructor arg) or per-call `signer`.

The all-zero `authSig` path is for development only: a gateway rejects it with 401. Production jobs should authenticate gateway requests.


### Node.js utility

```ts
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const wallet = walletFromKeypairFile("~/.config/solana/id.json");
```

### Browser wallet adapter

```ts
import type { MolphaWallet } from "@molpha/sdk";

const wallet: MolphaWallet = {
  publicKey: adapter.publicKey,
  signTransaction: (tx) => adapter.signTransaction(tx),
  signAllTransactions: (txs) => adapter.signAllTransactions(txs),
  signAuthMessage: async (msg) => new Uint8Array(await adapter.signMessage(msg)),
};
```

You can also override gateway auth per call with `gateway.requestSignedData({ ..., signer })` or with the same field in `requestAndSubmit`.

## Core flow

Use `MolphaSDK` for the end-to-end path, or use `MolphaSolanaClient` / `MolphaGateway` separately when you only need one side.

```ts
import { web3 } from "@anchor-lang/core";
import {
  MolphaSDK,
  PlanType,
  deriveSourceIdString,
} from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const sdk = new MolphaSDK({
  connection: new web3.Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: walletFromKeypairFile("~/.config/solana/id.json"),
});
```

### 1. Subscribe

Subscriptions are paid in USDC on Solana.

For local/dev testing on Solana Devnet, you can request test USDC from Circle's faucet: [https://faucet.circle.com/](https://faucet.circle.com/) (select `USDC` on `Solana Devnet`).

```ts
const plan = await sdk.solana.getPlan(PlanType.Basic);

// Show plan.subscriptionPrice to the user before charging.
const { pricePaid } = await sdk.solana.subscribe(PlanType.Basic, {
  maxPriceUsdc: plan.subscriptionPrice,
});
```

`maxPriceUsdc` is a safety bound. The transaction aborts if the live plan price is higher than the amount the user approved.

### 2. Source id

There is no create-feed instruction. A data source is identified by its canonical API config:

```text
sourceId = keccak256(JSON.stringify(canonicalizeAPIConfig(apiConfig)))
```

```ts
const apiConfig = {
  url: "https://api.example.com/price",
  responseParser: "$.price",
};

const sourceId = deriveSourceIdString(apiConfig); // 64 hex chars, no 0x
```

The canonical JSON has the fixed key order `url`, `method`, `headers` (sorted by UTF-16 code units, `{}` if empty), `responseParser`, `valueTransform` and, for [tolerance mode](#median-tolerance-mode), a trailing `aggregation`. The key is omitted for exact mode, so existing five-field configs keep their `sourceId`.

The gateway, the Solana program and the EVM/Starknet verifiers all recompute `sourceId` from the same canonical config, so pass the same `apiConfig` (including `{{secret.*}}` placeholders) every time. `signaturesRequired` is **not** part of `sourceId`: on Solana a feed account is keyed by `(sourceId, signaturesRequired, submitter)`, so the same source can be tracked at different quorums.

### 3. Request signed data from the gateway

```ts
const signaturesRequired = 3;
const result = await sdk.gateway.requestSignedData({
  apiConfig,
  signaturesRequired,
});
```

The gateway round uses the current on-chain registry version. Selected verifier nodes independently fetch/recompute the result and sign only if the observed value matches the canonical result.

The returned `Attestation` matches the cross-VM struct (`payload` + `signature`), plus gateway-only `value` (human-readable) and `fresh`. `payload` carries `sourceId`, the signed 32-byte `value`, `timestamp`, `registryVersion`, and `signaturesRequired`; `signature` carries the aggregate Schnorr material and `signersBitmap`. `signaturesRequired` must be at least the protocol's `min_signers` (currently 3) or the chain rejects the submit.

A gateway response is a coordination result, not proof of settlement or of on-chain verification. Consumers still decide freshness, source, quorum and replay policy.

### 4. Submit on Solana

```ts
const { signature, feed } = await sdk.solana.submitAttestation(result);
```

`submit_attestation` takes `{ attestation: { payload, signature }, rawValue, coalitionKey }` plus one read-only `Node` account per signer (ascending signer-bit order, resolved from the registry snapshot the round was signed against). The SDK builds all of it: it fetches the signer `Node` accounts in one batched read, sums their secp256k1 keys into the affine **coalition key** (`computeCoalitionKey`), and checks the program's signer-count bounds before sending. The coalition key is unsigned instruction data that the program checks projectively against its own sum, so a wrong key only fails the transaction. Pass `{ coalitionKey }` to skip the `Node` fetch when you already hold it.

If the signed 32-byte value is the keccak digest of a longer preimage, pass `{ rawValue }` (up to 256 bytes). The SDK verifies the digest before sending:

```ts
const { signature, feed } = await sdk.solana.submitAttestation(result, { rawValue });
```

**Compute budget and fees.** The transaction requests `estimateSubmitComputeUnits(signers)` compute units (about `43k + 9.2k` per signer, plus 15% and 10k of margin: roughly 140k at 8 signers), not the 1.4M maximum the old default asked for, which mattered once a priority fee is priced per requested unit. Pass `{ computeUnitLimit }` to override it. No priority fee is attached unless you ask: `{ priorityFeeMicroLamports: 2_000 }` sets a price in micro-lamports per unit, and `{ priorityFeeMicroLamports: "auto" }` uses the 75th percentile of the fees recently paid by writers of that feed (capped at 1 lamport per unit; an unreadable fee market means no fee). Use one of them when submits are dropped under load.

**Many feeds.** The client caches what feeds sharing a registry version have in common: the registry read (30 s), each signer `Node` key (never changes) and the coalition key of each signer set, and concurrent submits share one read. Submitting a fleet of feeds therefore costs one registry read and one `Node` read per distinct signer, not per submit. A stale or duplicate round is refused by the program in about 17-20k compute units, before it verifies the signature.

Then read the feed this wallet wrote for that source and quorum:

```ts
const feedState = await sdk.solana.readFeed(result.payload.sourceId, signaturesRequired);
```

`FeedAccount.value` is the 32 signed bytes (`valueKind.value`) or their keccak preimage hash (`valueKind.hash`); `submitter` is the wallet that created the feed.

The subscription read does not expose usage: the program stores no `used_rounds` / `prepaid_usdc` / `price`, and round quota is counted by the gateway's off-chain outbox. `SubscriptionInfo` carries only `owner`, `planType`, `validUntil`, `maxRounds`, `delegateCount`, `maxDelegates`, `maxSigners`.

### One-call request + submit

```ts
const { result, signature, feed } = await sdk.requestAndSubmit({
  apiConfig,
  signaturesRequired,
});
```

This is equivalent to:

```ts
const result = await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired });
const { signature, feed } = await sdk.solana.submitAttestation(result);
```

If the round succeeds but submitting fails, `requestAndSubmit` throws a `SubmitFailedError` that carries the signed attestation (`error.result`). The round already consumed quota and the attestation is valid, so submit `error.result` again instead of requesting a new round.

### Many feeds

For a large set of feeds use `requestMany` (also exported from the package root) instead of looping over `requestAndSubmit`:

```ts
import { requestMany } from "@molpha/sdk";

const results = await requestMany(sdk, feeds, {
  spreadMs: 1000, // spread starts by source hash so feeds due together do not arrive together
  request: { maxRetries: 6 },
});
for (const r of results) {
  if (!r.ok) console.error(r.label, r.error);
  else if (r.submitError) console.warn(r.label, "round ok, submit failed", r.submitError);
}
```

It reads the registry inputs once for the whole batch; bounds concurrency, starting from half the gateway's advertised `maxInflightRounds` (at most 64, else 32) and adapting (halving on a busy answer, growing back while requests succeed); runs Solana submits on their own smaller limiter (`submitConcurrency`, default 8); never discards the signed attestation of a round whose submit failed; and returns one result per feed in input order, so a failing feed does not stop the others. Pass `submit: false` to collect attestations only. Throughput is limited by the submit path (one transaction per attestation) long before it is limited by the gateway.

### Batching attestations of one feed

At a high update rate, submit several attestations of the same feed in one transaction:

```ts
const { signature, count } = await sdk.solana.submitAttestations([older, newer, newest]);
```

Each becomes its own `submit_attestation` instruction, sorted by timestamp, and instructions run in
the order they are listed, so every attestation is applied, oldest first. Separate transactions give
no such order. Sent a few hundred milliseconds apart they reach a leader in a different order often
enough (about a third at 250 ms spacing in a devnet run) that the older one is refused with
`FeedNotNewer`; a batch makes the spacing between transactions several times longer, and one
transaction costs one fee.

- All attestations must be for one feed (the same `sourceId` and `signaturesRequired`), with distinct
  timestamps. They may differ in registry version and signer set.
- The transaction is atomic. If a newer attestation of the feed has already landed, every
  instruction is stale and none applies, so batch what is due together and send batches of one feed
  in order.
- A transaction holds 1232 bytes, which is about three attestations with three signers, two with
  four or five. `maxAttestationsPerTransaction(signerCount, { distinctSigners })` estimates it, and a
  batch that does not fit throws `BatchTooLargeError` before sending, with `fits` saying how many
  go: submit those and the rest apart. A priority-fee instruction costs bytes too.
- `rawValue` is not supported in a batch; use `submitAttestation` for values longer than 32 bytes.
- An attestation waits for the others in its batch, so a batch of `n` made at an interval of `t`
  delays the oldest by `(n - 1) * t`.

### Fast requests with a cached context

By default every `requestSignedData` call reads the on-chain registry up front
(current version, redundancy buffer and node count of that snapshot) and fetches
the gateway node set only when the round needs it (private API encryption). When
you run many rounds for the same source, fetch these once and reuse them so each
round is a single gateway POST.

```ts
// Fetch registryVersion + redundancyBuffer + nodeCount + nodes once.
const context = await sdk.gateway.prepareContext();

// Reuse it across rounds — no prelude fetches.
const result = await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired, context });
```

`context` is a `Partial<RoundContext>`, so you can cache only what you have
and let `requestSignedData` fetch the rest:

```ts
const result = await sdk.gateway.requestSignedData({
  apiConfig,
  signaturesRequired,
  context: { nodes }, // registryVersion + redundancyBuffer + nodeCount still fetched fresh
});
```

Caching is opt-in because these inputs can drift. A stale `registryVersion`,
`redundancyBuffer`, `nodeCount`, or node set yields a result the chain will reject —
refresh the context when the on-chain registry changes. The SDK derives the
selection from the on-chain `nodeCount` and refuses a cached node list whose length
disagrees with it. The same `context` field is accepted by `requestAndSubmit`.

## Median tolerance mode

By default every signing node must observe the identical value. For noisy numeric sources
(prices), add an `aggregation` object and the selected nodes instead exchange signed
observations, drop stale ones and outliers, and sign the **lower median** of
`signaturesRequired` surviving observations:

```ts
const apiConfig = {
  url: "https://api.example.com/price",
  responseParser: "$.price",
  aggregation: {
    mode: "tolerance",
    rule: "median",
    maxDeviationBps: 50, // u32: allowed distance from the lower median, in bps
    maxAgeMs: 2000, // > 0: max observation age in milliseconds
    numeric: { type: "int256", decimals: 8 }, // value = round-half-even(price * 10^8)
  },
};

const { result } = await sdk.requestAndSubmit({ apiConfig, signaturesRequired: 5 });
```

Rules (the node is the reference; the SDK rejects violations before any request is made, with `AggregationConfigError`):

- `aggregation` is part of the `sourceId` and is **omitted** for exact mode. `mode: "exact"` is rejected because it would change the identity.
- Only `rule: "median"` and `numeric.type: "int256"` are supported. `decimals` is `0..255`, `maxDeviationBps` a u32, `maxAgeMs` a positive integer.
- Tolerance needs `signaturesRequired >= 3`.
- The nested object is rebuilt in canonical order (`mode`, `rule`, `maxDeviationBps`, `maxAgeMs`, `numeric{type, decimals}`); extra or reordered keys on your input never reach the hash. For the config above, `sourceId` hashes exactly `{"url":...,"method":"GET","headers":{},"responseParser":"$.price","valueTransform":"","aggregation":{"mode":"tolerance","rule":"median","maxDeviationBps":50,"maxAgeMs":2000,"numeric":{"type":"int256","decimals":8}}}` (pinned against the node's Go test `TestAggregationSourceIdentity`).
- The signed value is a signed `int256` (two's-complement `bytes32`). For tolerance results `Attestation.value` is rendered from the signed `payload.value` at the source's `decimals`, and `signature.signersBitmap` / signature fields must come from the response, since the nodes choose the final signing set after the observation exchange.
- The gateway must forward `aggregation` to the nodes. If it derives a different identity, the response's `sourceId` / `configHash` will not match and the SDK throws; a gateway that echoes `aggregation` in its response must echo the requested policy.

Helpers for the signed value (mirror the node's `new/tolerance` package):

```ts
import {
  encodeInt256Decimal, // ("42150.12345678", 8) -> 32-byte Uint8Array, round half to even, bounds-checked
  decodeInt256, //        bytes32 (Uint8Array | hex) -> bigint
  formatInt256Decimal, // bytes32 or bigint, decimals -> "42150.12345678" (trailing zeros trimmed)
  encodeInt256, //        bigint -> bytes32
  INT256_MIN,
  INT256_MAX,
} from "@molpha/sdk";

const feedState = await sdk.solana.readFeed(result.payload.sourceId, 5);
const price = formatInt256Decimal(Uint8Array.from(feedState!.value), 8);
```

## Private APIs and encrypted secrets

Sources can use private APIs without sending plaintext secrets to the gateway.

```ts
const result = await sdk.gateway.requestSignedData({
  apiConfig: {
    url: "https://api.example.com/private-price?key={{secret.apiKey}}",
    responseParser: "$.price",
  },
  signaturesRequired,
  encrypt: {
    secrets: {
      apiKey: process.env.API_KEY!,
    },
  },
});
```

`MolphaSDK` wires `verifyNodeKeys` to `solana.verifyNodeKeysForPrivateApi`, which authenticates gateway node encryption keys against the on-chain `Node` accounts of the round's registry snapshot (`registry.nodes[index]`) before secrets are encrypted.

Secrets are encrypted into per-node envelopes. The gateway coordinates the round but should not receive plaintext API credentials. Secrets are encrypted for every node of the registry (the committee is unknown until the gateway stamps the round), and the gateway forwards only the selected nodes' envelopes. `verifyNodeKeys` therefore authenticates all of them. The encrypted plaintext is the canonical config (including `aggregation`) with secrets substituted.

Private API access is still an active security-sensitive surface. Do not treat encrypted secret delivery as production-ready until gateway/node-side test vectors and validation are complete.

## Paywalled API sources

Some API sources answer an unpaid request with HTTP 402 instead of data. You pay such a
source directly, from your own wallet on the source's network. Molpha never holds, signs
for, or converts those funds, and the Molpha side of the round is unchanged: a paid
source still costs exactly one round of subscription quota.

```ts
import { createEvmSignerFromPrivateKey } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({
  apiConfig,
  signaturesRequired,
  sourcePayment: {
    signer: createEvmSignerFromPrivateKey(process.env.EVM_PRIVATE_KEY!),
  },
});
```

The SDK fetches the source unpaid to read its terms, signs one EIP-3009 transfer
authorization per node in the round's eligible set, and sends them as `sourcePayments`.
Beta signs `exact` payments in USDC on Base and Base Sepolia only; any other network or
asset is rejected before you sign anything. Private keys stay in your process — pass your
own `EvmSigner` to keep them in a wallet or KMS instead.

**You pay per node fetch, not per datum.** Independent fetching is the point of the
protocol, so one round costs up to
`min(signaturesRequired + redundancyBuffer, nodeCount)` source calls — the same eligible
set the selection bitmap is drawn from. Only authorizations a node actually spends ever
settle, so unused ones cost nothing. Sign the whole set anyway: a short set starves buffer
nodes and makes the round more likely to fail.

Each retry signs fresh authorizations with new nonces, because a dispatched round cannot
be replayed and a retry is therefore a new round. Authorizations the source already
settled stay spent if the round then fails; unsettled ones expire worthless. There is no
refund path and none is needed.

Source payment is per-round access material, like a credential. It never enters
`sourceId`, so a paid and an unpaid fetch of the same API config share one source
identity.

### Without a source wallet

A paywalled source with no `sourcePayment` throws `UpstreamPaymentRequiredError`, whose
`quote` carries the resource, the eligible set size, and the source's own rejection
detail. This is terminal — the round is never retried blindly.

```ts
import { UpstreamPaymentRequiredError } from "@molpha/sdk";

try {
  await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired });
} catch (err) {
  if (err instanceof UpstreamPaymentRequiredError) {
    console.log(`${err.quote.resource} needs ${err.quote.eligibleSetSize} paid fetches`);
  }
}
```

To drive the payment yourself, `probeSource`, `signSourcePayments` and `eligibleSetSize`
are exported for x402-native agents calling `/v1/x402/execute` with their own client.
`gateway.getNodesInfo()` reports the gateway's advisory view of the registry policy that
sizes the eligible set, for callers with no Solana connection.

## EVM verification

After a gateway round, the same signed result can be verified on EVM chains.

The SDK ships deployed testnet verifier addresses and framework-agnostic tuple builders. It does not depend on ethers or viem at runtime.

### Deployed verifier address

The verifier is deployed with CREATE2 so the contract address is the same on every
supported EVM chain.

```ts
import { MOLPHA_VERIFIER_ADDRESS } from "@molpha/sdk";

const address = MOLPHA_VERIFIER_ADDRESS;
```

Supported network ids (selection helpers only): `evm-sepolia`, `arbitrum-sepolia`, `avalanche-fuji`, `bsc-testnet`.

### Build verifier arguments

The verifier's entrypoint is
`verify(Attestation attestation, uint64 maxAge) returns (bool success, uint8 code)`.

```ts
import { buildEvmVerifierArgs } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired });

const { attestation, maxAge } = buildEvmVerifierArgs(result, { maxAge: 300 });
```

`maxAge` is required. It is the freshness window in seconds: the verifier reports an older
attestation as `STALE`, and one dated after `block.timestamp` as `MALFORMED`. `0` disables the
check entirely — pass it only when your contract enforces freshness or ordering itself, because
a stateless verifier otherwise accepts a correctly signed attestation forever.

The generated object matches the Solidity `IVerifier.Attestation` struct, using viem's
primitive types so it passes straight into `readContract` or an ethers `Contract`. Member
order is ABI order (and the signed message's order). The gateway `Attestation` uses the same
nested shape with lowercase hex strings instead of viem primitives:

```ts
attestation:
{
  payload: {
    value: `0x${string}`,          // bytes32 (Attestation.payload.value)
    sourceId: `0x${string}`,       // bytes32
    registryVersion: number,       // uint32
    signaturesRequired: number,    // uint8
    timestamp: bigint,    // uint64
  },
  signature: {
    signature: `0x${string}`,      // bytes32 (Attestation.signature.s)
    commitment: `0x${string}`,     // address (Attestation.signature.commitmentAddr)
    signersBitmap: bigint,         // uint256
  },
}
maxAge: bigint                     // uint64
```

The builder range-checks every integer against its Solidity type. Out-of-range calldata never
reaches `verify`: the ABI decoder reverts on it instead of returning a result code.

### viem

```ts
import { createPublicClient, http } from "viem";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ABI,
  MOLPHA_VERIFIER_ADDRESS,
  parseEvmVerifyResult,
} from "@molpha/sdk";

const client = createPublicClient({ chain, transport: http() });
const { attestation, maxAge } = buildEvmVerifierArgs(result, { maxAge: 300 });

const returned = await client.readContract({
  address: MOLPHA_VERIFIER_ADDRESS,
  abi: MOLPHA_VERIFIER_ABI,
  functionName: "verify",
  args: [attestation, maxAge],
});

const { success, code, reason } = parseEvmVerifyResult(returned);
// { success: true, code: 0, reason: "OK" }
// { success: false, code: 10, reason: "STALE" }
```

### ethers

```ts
import { Contract } from "ethers";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ABI,
  MOLPHA_VERIFIER_ADDRESS,
  parseEvmVerifyResult,
} from "@molpha/sdk";

const verifier = new Contract(MOLPHA_VERIFIER_ADDRESS, MOLPHA_VERIFIER_ABI, provider);
const { attestation, maxAge } = buildEvmVerifierArgs(result, { maxAge: 300 });

const { success, code, reason } = parseEvmVerifyResult(await verifier.verify(attestation, maxAge));
```

### Raw `eth_call`

`encodeEvmVerifyCalldata` produces the full calldata (selector `0x67e2907b` plus nine static
words), and `parseEvmVerifyResult` also accepts the raw 64-byte return data:

```ts
import { buildEvmVerifierArgs, encodeEvmVerifyCalldata, parseEvmVerifyResult } from "@molpha/sdk";

const args = buildEvmVerifierArgs(result, { maxAge: 300 });
const returnData = await provider.call({ to: verifierAddress, data: encodeEvmVerifyCalldata(args) });

const { success, code, reason } = parseEvmVerifyResult(returnData);
```

`verify` never reverts; a rejection is a result code from the shared `VERIFY_CODES` table (see
[the Starknet section](#call-verify-and-read-the-result) for the full list). The EVM verifier
returns `MALFORMED` for a zero `signaturesRequired`, a zero or out-of-range signature scalar, a
zero commitment, or fewer set bitmap bits than `signaturesRequired`. `parseEvmVerifyResult`
throws when `success` and `code` disagree, which means the call did not reach a Molpha verifier
of this interface.

### Registry reads

`MOLPHA_VERIFIER_ABI` also covers every read-only registry view — `getRegistryVersion`,
`getTotalNodes`, `redundancyBuffer`, `getRegistryRoot` / `getRegistryPointer` (current or per
version), `activatesAt`, `retiredAt`, `isLatestVersion`, `nodeStatus`, `isNode` — and the
`InvalidRegistryVersion` error the per-version views revert with. Owner-only mutators are not
included.

Lower-level helpers are also exported for manual integrations:

```ts
import {
  toFixedHex,
  signersBitmapToUint256,
  signersBitmapToDecimal,
} from "@molpha/sdk";
```

## Starknet verification

After a gateway round, the same signed result can be verified on Starknet.

The SDK ships deployed testnet verifier addresses and framework-agnostic struct
builders. It does not depend on `starknet.js` at runtime.

### Deployed verifier addresses

```ts
import {
  MOLPHA_VERIFIER_STARKNET_ADDRESSES,
  MOLPHA_VERIFIER_STARKNET_SEPOLIA,
  getMolphaStarknetVerifierAddress,
} from "@molpha/sdk";

const address = getMolphaStarknetVerifierAddress("starknet-sepolia");

// or:
const sepolia = MOLPHA_VERIFIER_STARKNET_ADDRESSES["starknet-sepolia"];
const sepoliaDirect = MOLPHA_VERIFIER_STARKNET_SEPOLIA;
```

| Network | Constant |
|---|---|
| Starknet Sepolia | `MOLPHA_VERIFIER_STARKNET_SEPOLIA` |

### Build verifier arguments

The verifier's entrypoint is `verify(attestation: Attestation, max_age: u64) -> (bool, u8)`.

```ts
import { buildStarknetVerifierArgs } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired });

const { attestation, maxAge } = buildStarknetVerifierArgs(result, { maxAge: 300 });
```

`maxAge` is required. It is the freshness window in seconds: the verifier reports an older
attestation as `STALE`. `0` disables the check entirely — pass it only when your contract
enforces freshness or ordering itself, because a stateless verifier otherwise accepts a
correctly signed attestation forever.

The generated object matches the Cairo `Attestation` struct. Member order is Cairo `Serde`
order (and the signed message's order). The gateway `Attestation` uses the same nested shape
with lowercase hex strings instead of Cairo felts:

```ts
attestation:
{
  payload: {
    value: u256,
    source_id: u256,
    registry_version: u32,
    signatures_required: u8,
    timestamp: u64,
  },
  signature: {
    signature: u256,
    commitment: felt252, // 20-byte address as felt
    signers_bitmap: u256,
  },
}
```

The builder range-checks every integer against its Cairo type. Out-of-range calldata never
reaches `verify`: Cairo `Serde` fails while decoding the arguments and the call reverts
instead of returning a result code.

### Call `verify` and read the result

`encodeStarknetVerifyCalldata` flattens the arguments into the 13 felts a raw `starknet_call`
takes, and `parseStarknetVerifyResult` decodes the `(bool, u8)` it returns. Any Starknet
client works; with `starknet.js`:

```ts
import { RpcProvider } from "starknet";
import {
  buildStarknetVerifierArgs,
  encodeStarknetVerifyCalldata,
  parseStarknetVerifyResult,
} from "@molpha/sdk";

const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
const args = buildStarknetVerifierArgs(result, { maxAge: 300 });

const response = await provider.callContract({
  contractAddress: verifierAddress,
  entrypoint: "verify",
  calldata: encodeStarknetVerifyCalldata(args),
});

const { success, code, reason } = parseStarknetVerifyResult(response);
// { success: true, code: 0, reason: "OK" }
// { success: false, code: 10, reason: "STALE" }
```

`verify` never reverts on well-formed calldata; a rejection is a result code. The codes are
shared with the EVM verifier contract and exported as `VERIFY_CODES`:

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | Verified |
| 2 | `BAD_REGISTRY_VERSION` | `registryVersion` does not exist on this verifier |
| 3 | `MALFORMED` | Structurally invalid input, or dated in the future when `maxAge != 0` |
| 4 | `NOT_YET_ACTIVE` | `timestamp` predates the registry version's activation |
| 5 | `VERSION_EXPIRED` | Registry version superseded more than the grace window earlier |
| 7 | `BAD_QUORUM` | Signers are not within the round's derived selection group |
| 8 | `BAD_AGGREGATE` | The signers' aggregate key is the point at infinity |
| 9 | `BAD_SIGNATURE` | The aggregate Schnorr signature does not verify |
| 10 | `STALE` | Older than `maxAge` |

Codes 1 and 6 are reserved and never returned. Codes are append-only, so
`parseStarknetVerifyResult` reports a code newer than your SDK as `reason: "UNKNOWN"` rather
than throwing.

Lower-level helpers are also exported:

```ts
import {
  commitmentAddressToStarknetFelt,
  signersBitmapToStarknetUint256,
  verifyCodeName,
} from "@molpha/sdk";
```

## What verification checks

A Molpha attestation is valid only if the verifier can confirm:

- the update targets the expected `sourceId`;
- the result was signed against a specific `registryVersion` (an immutable node-set snapshot);
- the quorum satisfies `signaturesRequired`;
- the signer bitmap is a subset of the deterministic selection for `(sourceId, registryVersion, timestamp)`;
- the aggregate Schnorr signature over `attestationMessageHash(...)` is valid;
- the timestamp is within the accepted freshness bounds;
- on Solana, the signer `Node` accounts passed as remaining accounts are exactly `registry.nodes[bit]` for every set bit, and the supplied coalition key matches the sum of their keys.

A valid signature does not replace consumer policy: freshness, source, quorum and replay checks remain the consumer's responsibility.

Solana verification finalizes feed state via `submit_attestation`. EVM and Starknet verification are stateless and return whether the signed Molpha attestation is valid for the deployed verifier registry.

## IDL vendoring

The Solana client needs the Anchor IDL for the Molpha program.

A vendored copy ships under `idl/` and is used by default:

```ts
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "@molpha/sdk";
```

Override `idl` and `programId` when targeting another deployment.

The vendored IDL is `anchor idl build -p molpha` output for `molpha-solana-program` `3d01170` ("Epoch settlements (#47)").

Keep the vendored IDL aligned with the deployed program. Mismatched IDL/program versions can produce invalid account derivations, decoding errors, or failed instruction simulation.

## Standalone clients

`MolphaSDK` is a convenience facade.

You can also use the lower-level clients directly:

```ts
import {
  MolphaGateway,
  MolphaSolanaClient,
  gatewaySignerFromWallet,
} from "@molpha/sdk";

const solana = MolphaSolanaClient.create({
  connection,
  wallet,
});

const gateway = new MolphaGateway(
  endpoints,
  () => solana.getRegistrySelectionConfig(),
  gatewaySignerFromWallet(wallet),
  {
    defaultSubscriptionOwner: wallet.publicKey.toBase58(),
    verifyNodeKeys: (args) => solana.verifyNodeKeysForPrivateApi(args),
  },
);
```

The facade wires the registry selection config resolver, gateway signer, subscription owner, and node-key verifier automatically.

## Status

Pre-1.0. The `latest` dist-tag is `0.1.0` (stable profile). Newer features described in this README (for example tolerance mode, `requestMany` and paywalled API sources) may be available only on the `dev` tag until the next stable release. See [CHANGELOG.md](./CHANGELOG.md).

Current scope:

- Solana subscription and extend flow;
- deterministic source id and attestation message hashing;
- gateway signed-data requests (failover, retries with backoff, per-gateway request auth, context cache);
- Solana attestation submission and feed/registry reads;
- private API encryption helpers (pre-production);
- caller-funded x402 payments for paywalled API sources (Base USDC, pre-production);
- EVM and Starknet verifier argument building, `verify` calldata encoding and result decoding;
- deployed testnet verifier address helpers.

Known limitations:

- private API envelope encryption still needs gateway/node-side test-vector validation;
- paid-source payments sign `exact` USDC on Base and Base Sepolia only, and are pending
  end-to-end validation against a live paywalled source;
- verifier-node registration and admin tooling are intentionally outside this package;
- production deployments should use authenticated gateway requests;
- testnet verifier addresses may change between protocol releases.

Solana paths such as selection bitmap and `submit_attestation` remaining-accounts resolution are aligned with the IDL selected by the active deployment profile (`idl/profiles/{stable,dev}/molpha.json`).

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm e2e-demo
```

## Releasing

Versioning and publishing are automated with Changesets.

Versions follow semver and are driven by the nature of each change, not by the branch it merges from.

### Workflow

1. Add a changeset with your change:

   ```bash
   pnpm changeset
   ```

   Choose:

   - `patch` for fixes;
   - `minor` for features;
   - `major` for breaking changes.

   While the package is pre-`1.0.0`, use `minor` for breaking changes and `patch` for features/fixes. Only select `major` when intentionally cutting `1.0.0`.

2. Stable releases from `main`

   When changes land on `main`, the release workflow opens a release PR that bumps `package.json` and updates `CHANGELOG.md`.

   Merging that PR publishes to npm on the `latest` tag:

   ```bash
   npm install @molpha/sdk
   ```

3. Prereleases from `dev`

   Pushes to `dev` publish a snapshot version on the `dev` dist-tag, for example:

   ```text
   0.2.0-dev-<timestamp>
   ```

   Install with:

   ```bash
   npm install @molpha/sdk@dev
   ```

   Requires at least one pending changeset.

### One-time setup

1. Configure npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) for `@molpha/sdk`:

   ```text
   npmjs.com → @molpha/sdk → Settings → Trusted publishing
   ```

   Add a trusted publisher for the release workflow:

   | Workflow file | Branches       | Purpose                         |
   | ------------- | -------------- | ------------------------------- |
   | `release.yml` | `main`, `dev`  | Stable releases + dev snapshots |

   Use organization `Molpha`, repository `sdk`, and the exact workflow filename (including `.yml`). No `NPM_TOKEN` secret is required.

2. Publish a stable release from `main` first.

   npm assigns the first published version to the `latest` tag regardless of `--tag`. If a `dev` snapshot is published before any stable release, that prerelease can become `latest`.

   The `dev` workflow should guard against this and fail until a stable `latest` exists.

If `latest` ever points to a prerelease, repoint it after publishing a stable version:

```bash
npm dist-tag add @molpha/sdk@<stable-version> latest
```
