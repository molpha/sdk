---
"@molpha/sdk": minor
---

Bake distinct deployment defaults per npm channel at build time.

**Added**

- `config/deployments.json` and `idl/profiles/{stable,dev}/` — selected by `MOLPHA_SDK_PROFILE` via `scripts/select-profile.ts` before build/test.
- `MOLPHA_SDK_PROFILE` and `MOLPHA_DEV_VERIFIERS_PROVISIONAL` exports so consumers can see which defaults were baked in.

**Fixed**

- `@molpha/sdk@latest` (`stable`) now defaults to `https://gateway.molpha.io/` and the Brebeneskul program `MoLFGDp…` instead of the shared dev-gateway URL.
- `@molpha/sdk@dev` defaults to `https://dev-gateway.molpha.io/` and program `chivcFQ…`. EVM/Starknet addresses stay provisional (stable fallback) until the Attestation-interface redeploy fills the manifest.
