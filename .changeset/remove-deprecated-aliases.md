---
"@molpha/sdk": minor
---

Remove compatibility aliases: `deriveApiConfigHash`, `submitDataUpdate`, `nodeWalletFromFile`, `keypairFileSigner`, `DataUpdateResult`, and `attestationMessageHashFromResult`. Use `deriveSourceId`, `submitAttestation`, `walletFromKeypairFile`, `Attestation` / `AttestationPayload`, and `attestationMessageHashFromAttestation` instead.

`Attestation` nests signed fields under `payload` and `signature` (replacing flat `valuePacked`, `timestamp`, and top-level signature fields). Gateway `value` remains the human-readable decode.
