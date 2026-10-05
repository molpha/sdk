---
"@molpha/sdk": minor
---

Gateway-assigned millisecond timestamp.

**Breaking**

- `timestamp` is unix **milliseconds** and is assigned by the gateway on a tick grid; the
  caller never chooses it. The request body carries no round timestamp. `requestSignedData` takes
  `timestamp`, the signers' bitmap and the rest of the signed fields from the response and
  refuses a response that lacks any of them. The response is the gateway's nested
  `{ status, data: { attestation: { payload, signature }, value, fresh } }` shape only.
- `deriveSelectionSeed` hashes the one-second window index, `timestamp / 1000`
  (`SELECTION_WINDOW_MS`), under `MOLPHA_SELECTION_V1`; committees follow the timestamp's second.
  `deriveSelectionBitmap`'s `ts` is in milliseconds.
- A retry after a 409 (or any failed attempt) waits for the next gateway tick (`tickMs`, default 1000)
  so it is a new round, not a duplicate of the last.
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
