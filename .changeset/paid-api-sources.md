---
"@molpha/sdk": minor
---

Support API sources that are themselves x402-paywalled, matching the gateway's paid-source release.

**New**

- `requestSignedData({ sourcePayment: { signer } })` pays a paywalled source directly from the caller's own wallet. The SDK reads the source's own 402, signs one EIP-3009 transfer authorization per node in the round's eligible set (`min(signaturesRequired + redundancyBuffer, nodeCount)`), and sends them as `sourcePayments`. Payment goes to the source, never to Molpha, and the round still costs exactly one round of subscription quota.
- `UpstreamPaymentRequiredError` — thrown, with the gateway's `quote`, when a source is paywalled and no `sourcePayment` was supplied. Terminal: such a round is never retried blindly.
- `probeSource`, `signSourcePayments`, `eligibleSetSize`, `parseUpstreamQuote` for x402-native agents driving `/v1/x402/execute` with their own client.
- `createEvmSignerFromPrivateKey`, `evmAddressFromPrivateKey`, and EIP-712/EIP-3009 primitives (`transferWithAuthorizationDigest`, `domainSeparator`, `toChecksumAddress`). Isomorphic — no `Buffer`, so browser bundles are unaffected.
- `gateway.getNodesInfo()` returns the peer set plus the gateway's advisory `registry` policy (`version`, `nodeCount`, `redundancyBuffer`) now reported by `GET /v1/nodes`. The on-chain read stays authoritative for `requestSignedData`.
- `bytesToBase64` / `base64ToBytes` encoding helpers.

Beta signs `exact` payments in USDC on Base and Base Sepolia only; any other network or asset is rejected before anything is signed.

**Fixed**

- Retried rounds now always advance the canonical timestamp. Retries within the same wall-clock second previously reused a timestamp, and so re-sent an already-dispatched round tuple that the gateway cannot replay.
