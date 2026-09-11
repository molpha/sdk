# @molpha/sdk

Browser-first TypeScript SDK for **Molpha data consumers and feed owners**.

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
  └─ signs a RequestAuth bound to (programId, gateway, sourceId, signaturesRequired, timestamp)

Gateway
  └─ coordinates a signing round for (sourceId, signaturesRequired)

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
  keccak256("MOLPHA_MESSAGE_V1") || sourceId || u32be(registryVersion) ||
  u32be(signaturesRequired) || signersBitmap || value || u64be(canonicalTimestamp)
)
```

`attestationMessageHash` / `attestationMessageHashFromResult` recompute it client-side.

## Install

```bash
pnpm add @molpha/sdk
```

Runtime dependencies include `@solana/kit`, `@anchor-lang/core`, and `@noble/*`. `bn.js` is an optional peer dependency (used by the Solana / Anchor path).

> **Migration from `@molpha-oracle/sdk`:** The package was renamed to `@molpha/sdk` starting at `0.1.0`. `@molpha-oracle/sdk` is deprecated — update install commands and imports:
>
> ```bash
> pnpm remove @molpha-oracle/sdk
> pnpm add @molpha/sdk
> ```
>
> Replace `@molpha-oracle/sdk` with `@molpha/sdk` in all import paths (including `@molpha/sdk/utils`).

| Import | Use |
|---|---|
| `@molpha/sdk` | Facade (`MolphaSDK`), `MolphaGateway`, `MolphaSolanaClient`, core hashing (`deriveSourceId`, `attestationMessageHash`, `hashRequestAuth`), EVM/Starknet helpers. Browser-safe; no `fs` in the main entry. |
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
const sourceId = deriveSourceIdString(apiConfig); // === result.sourceId
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
  "MOLPHA_REQAUTH_V1" || programId || gatewayPda || sourceId || u8(signaturesRequired) || u64le(timestamp)
)
gatewayPda = PDA(["molpha_gateway", gatewayAuthority], programId)
```

Pass `gatewayAuthority` (the gateway's base58 signing pubkey) per endpoint to pin it. When omitted, the SDK calls `GET {url}/v1/info` once per endpoint and reads:

```json
{ "status": "ok", "data": { "gatewayAuthority": "<base58>", "programId": "<base58>" } }
```

A `programId` that differs from the client's is rejected. Because the hash differs per gateway, the auth signature is recomputed for every endpoint actually tried during failover — with a browser wallet that means one signing prompt per endpoint tried. `/v1/info` is never contacted when no signer is configured (dev zero-signature path).

## Wallet

`wallet` is a single `MolphaWallet` used across both protocol surfaces:

| Layer | What it signs |
|---|---|
| Solana client | Transactions such as `subscribe`, `extendSubscription`, `submitAttestation` |
| Gateway client | `hashRequestAuth({ programId, gateway, sourceId, signaturesRequired, timestamp })` for authenticated gateway requests |

Gateway auth is resolved automatically when you use `MolphaSDK`:

1. Use `wallet.signAuthMessage` if provided.
2. Else derive signing from Anchor `Wallet.payer` when the secret key is available, such as with `walletFromKeypairFile`.
3. Else omit auth and use an all-zero `authSig`.

`MolphaSDK` passes the resolved signer to `sdk.gateway` as its default, so
`sdk.gateway.requestSignedData({ apiConfig, signaturesRequired })` authenticates without an
explicit `signer`. Standalone `new MolphaGateway(...)` omits auth unless you pass
a `defaultSigner` (third constructor arg) or per-call `signer`.

The all-zero `authSig` path is for development only. Production jobs should authenticate gateway requests.

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
  deriveApiConfigHash,
  deriveFeedIdString,
} from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const sdk = new MolphaSDK({
  connection: new web3.Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: walletFromKeypairFile("~/.config/solpha/id.json"),
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

The returned `DataUpdateResult` includes `sourceId`, the signed value, canonical timestamp, registry version, required quorum, signer bitmap, and aggregate signature. `signaturesRequired` must be at least the protocol's `min_signers` (currently 3) or the chain rejects the submit.

### 4. Submit on Solana

```ts
const { signature, feed } = await sdk.solana.submitAttestation(result);
```

Then read the feed this wallet wrote for that source and quorum:

```ts
const feedState = await sdk.solana.readFeed(result.sourceId, signaturesRequired);
```

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

Secrets are encrypted into per-node envelopes. The gateway coordinates the round but should not receive plaintext API credentials.

Private API access is still an active security-sensitive surface. Do not treat encrypted secret delivery as production-ready until gateway/node-side test vectors and validation are complete.

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

```ts
import { buildEvmVerifierArgs } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired });

const { dataUpdate, signature } = buildEvmVerifierArgs(result);
```

The generated tuples match the Molpha EVM verifier ABI:

```ts
// dataUpdate:
// [bytes32 sourceId,
//  uint32 registryVersion,
//  uint32 signaturesRequired,
//  bytes32 valuePacked,
//  uint64 timestamp]

// signature:
// [bytes32 s,
//  address commitment,
//  uint256 signersBitmap]
```

Note: the deployed contract's source names the first struct field `jobId`; the SDK ABI names it `sourceId` (component names do not affect encoding) and the value is the 32-byte source id.

### ethers

```ts
import { Contract } from "ethers";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ADDRESS,
} from "@molpha/sdk";

const verifier = new Contract(
  MOLPHA_VERIFIER_ADDRESS,
  abi,
  signer,
);

const { dataUpdate, signature } = buildEvmVerifierArgs(result);

await verifier.verify(dataUpdate, signature);
```

### viem

```ts
import { createPublicClient, http } from "viem";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ABI,
  MOLPHA_VERIFIER_ADDRESS,
} from "@molpha/sdk";

const client = createPublicClient({
  chain,
  transport: http(),
});

const { dataUpdate, signature } = buildEvmVerifierArgs(result);

await client.readContract({
  address: MOLPHA_VERIFIER_ADDRESS,
  abi: MOLPHA_VERIFIER_ABI,
  functionName: "verify",
  args: [
    {
      sourceId: dataUpdate[0],
      registryVersion: dataUpdate[1],
      signaturesRequired: dataUpdate[2],
      value: dataUpdate[3],
      canonicalTimestamp: BigInt(dataUpdate[4]),
    },
    {
      signature: signature[0],
      commitment: signature[1],
      signersBitmap: signature[2],
    },
  ],
});
```

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

```ts
import { buildStarknetVerifierArgs } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({ apiConfig, signaturesRequired });

const { dataUpdate, signature } = buildStarknetVerifierArgs(result);
```

The generated objects match the Molpha Starknet verifier interface (the Cairo struct still names the first field `feed_id`; positional calldata is unchanged):

```ts
// dataUpdate:
// {
//   source_id: u256,
//   registry_version: u32,
//   signatures_required: u32,
//   value: u256,
//   canonical_timestamp: u64,
// }

// signature:
// {
//   signature: u256,
//   commitment: felt252, // EVM-style 20-byte address as felt
//   signers_bitmap: u256,
// }
```

Lower-level helpers are also exported:

```ts
import {
  commitmentAddressToStarknetFelt,
  signersBitmapToStarknetUint256,
} from "@molpha/sdk";
```

## What verification checks

A Molpha attestation is valid only if the verifier can confirm:

- the update targets the expected `sourceId`;
- the result was signed against a specific `registryVersion` (an immutable node-set snapshot);
- the quorum satisfies `signaturesRequired`;
- the signer bitmap is a subset of the deterministic selection for `(sourceId, registryVersion, canonicalTimestamp)`;
- the aggregate Schnorr signature over `attestationMessageHash(...)` is valid;
- the timestamp is within the accepted freshness bounds;
- on Solana, the signer `Node` accounts passed as remaining accounts are exactly `registry.nodes[bit]` for every set bit.

Solana verification finalizes feed state via `submit_attestation`. EVM and Starknet verification are stateless and return whether the signed Molpha attestation is valid for the deployed verifier registry.

## IDL vendoring

The Solana client needs the Anchor IDL for the Molpha program.

A vendored copy ships under `idl/` and is used by default:

```ts
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "@molpha/sdk";
```

Override `idl` and `programId` when targeting another deployment.

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

`0.0.0` (unreleased) — first stable release `@molpha/sdk@0.1.0` is pending via changesets.

Current scope:

- Solana subscription and extend flow;
- deterministic source id and attestation message hashing;
- gateway signed-data requests (failover, retries, per-gateway request auth, context cache);
- Solana attestation submission and feed/registry reads;
- private API encryption helpers (pre-production);
- EVM and Starknet verifier argument building;
- deployed testnet verifier address helpers.

Known limitations:

- private API envelope encryption still needs gateway/node-side test-vector validation;
- verifier-node registration and admin tooling are intentionally outside this package;
- production deployments should use authenticated gateway requests;
- testnet verifier addresses may change between protocol releases.

Solana paths such as selection bitmap and `submit_attestation` remaining-accounts resolution are aligned with the Molpha program version vendored in this repo (`MoLFnEbuMS5gWnXNfUMLAYSqRM3eQZKWRzjeMQfqbT3`, not yet deployed).

## Migrating from 0.1.x

| Before | After |
|---|---|
| `deriveFeedId(owner, apiConfigHash, sigReq)` / `deriveFeedIdString` | removed — use `deriveSourceId(apiConfig)` / `deriveSourceIdString` |
| `deriveApiConfigHash(apiConfig)` | `deriveSourceId(apiConfig)` (old name kept as a deprecated alias, same bytes) |
| `requestSignedData({ feedId, ... })` | `requestSignedData({ apiConfig, signaturesRequired, ... })` — `sourceId` is derived from `apiConfig` |
| `prepareContext(feedId)` | `prepareContext()` |
| `requestAndSubmit(feedId, opts)` | `requestAndSubmit(opts)` |
| `authMessage(feedId, timestamp)` (sha256) | `hashRequestAuth({ programId, gateway, sourceId, signaturesRequired, timestamp })` (keccak) |
| `endpoints: string[]` | `endpoints: (string \| { url, gatewayAuthority })[]` |
| `submitDataUpdate(result)` | `submitAttestation(result)` (deprecated alias kept); returns `{ signature, feed }` |
| `readFeed(feedId)` | `readFeed(sourceId, signaturesRequired, submitter?)` |
| `result.feedId` / `NodeKeyVerifierArgs.feedId` | `.sourceId` |
| EVM tuple `feedId`, ABI `jobId` | `sourceId` |
| Starknet `feed_id` | `source_id` |
| `resolveRegistryIndexForVersion`, `VIRTUAL_INDEX`, `nodePda(index)` | removed — signer accounts are `registry.nodes[bit]`; `nodePda(owner)` |

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

   Add a trusted publisher for each release workflow:

   | Workflow file       | Branch | Purpose          |
   | ------------------- | ------ | ---------------- |
   | `release.yml`       | `main` | Stable releases  |
   | `release-dev.yml`   | `dev`  | Dev snapshots    |

   Use organization `Molpha`, repository `sdk`, and the exact workflow filename (including `.yml`). No `NPM_TOKEN` secret is required.

2. Publish a stable release from `main` first.

   npm assigns the first published version to the `latest` tag regardless of `--tag`. If a `dev` snapshot is published before any stable release, that prerelease can become `latest`.

   The `dev` workflow should guard against this and fail until a stable `latest` exists.

3. Deprecate the legacy package name on npm (one-time, after `@molpha/sdk@0.1.0` is published):

   ```bash
   npm deprecate "@molpha-oracle/sdk" "Package renamed to @molpha/sdk. Please migrate."
   ```

If `latest` ever points to a prerelease, repoint it after publishing a stable version:

```bash
npm dist-tag add @molpha/sdk@<stable-version> latest
```
