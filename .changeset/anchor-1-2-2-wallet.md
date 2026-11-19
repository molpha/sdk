---
"@molpha/sdk": patch
---

`@molpha/sdk/utils` loads with `@anchor-lang/core` 1.2.2.

Anchor 1.2.2 exports `Wallet` through a getter that Node's ESM loader does not see as a named
export of the CommonJS package, so `import { Wallet } from "@anchor-lang/core"` in
`dist/utils.js` failed with `SyntaxError: ... does not provide an export named 'Wallet'`. The
SDK no longer imports Anchor's `Wallet` at runtime:

- `KeypairWallet` (new, exported from `@molpha/sdk` and `@molpha/sdk/utils`): an Anchor `Wallet`
  backed by a keypair that signs legacy and versioned transactions, with the same behaviour as Anchor's
  Node `Wallet`.
- `walletFromKeypairFile` returns a `KeypairWallet`.
- `Wallet` from `@molpha/sdk/utils` is now the SDK's subclass of `KeypairWallet`, with
  `new Wallet(keypair)` and `Wallet.local()` as before. It is no longer Anchor's class, so
  `instanceof` checks against Anchor's `Wallet` no longer match.

The peer range stays `^1.2.1`. A test loads the built `index` and `utils` entry points in a
plain Node process against the locked Anchor version, now 1.2.2.
