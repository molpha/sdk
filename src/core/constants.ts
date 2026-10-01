/**
 * Protocol-wide constants that must stay in sync with the vendored IDL. Kept as plain
 * literals so gateway-only / browser bundles never pull in `idl/molpha.json`.
 */

/** Molpha program id (`idl/molpha.json` → `address`). Asserted equal in `test/gateway-auth.test.ts`. */
export const MOLPHA_PROGRAM_ID = "chivcFQgxzwkpLvW41PV431HQ4dYpaW3povQH3AdpQt";
