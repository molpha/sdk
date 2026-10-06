/**
 * Guards the build-time deployment profile: IDL address, gateway URL, and verifier
 * constants must agree with `config/deployments.json` / `scripts/select-profile.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MOLPHA_DEV_VERIFIERS_PROVISIONAL,
  MOLPHA_PROGRAM_ID,
  MOLPHA_SDK_PROFILE,
} from "../src/core/constants.js";
import { MOLPHA_VERIFIER_ADDRESS } from "../src/evm/constants.js";
import { DEFAULT_GATEWAY_ENDPOINT } from "../src/gateway/index.js";
import { MOLPHA_VERIFIER_STARKNET_SEPOLIA } from "../src/starknet/constants.js";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";

interface ProfileConfig {
  gatewayUrl: string;
  solanaProgramId: string;
  evmVerifier: string | null;
  starknetSepolia: string | null;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(root, "config/deployments.json"), "utf8"),
) as { stable: ProfileConfig; dev: ProfileConfig };

describe("deployment profile", () => {
  it("matches MOLPHA_SDK_PROFILE to a known manifest entry", () => {
    expect(["stable", "dev"]).toContain(MOLPHA_SDK_PROFILE);
  });

  it("binds program id, IDL address, and gateway URL to the active profile", () => {
    const profile = manifest[MOLPHA_SDK_PROFILE];
    expect(MOLPHA_PROGRAM_ID).toBe(profile.solanaProgramId);
    expect(MOLPHA_PROGRAM_ADDRESS).toBe(profile.solanaProgramId);
    expect(MOLPHA_IDL.address).toBe(profile.solanaProgramId);
    const expectedGateway = profile.gatewayUrl.endsWith("/")
      ? profile.gatewayUrl
      : `${profile.gatewayUrl}/`;
    expect(DEFAULT_GATEWAY_ENDPOINT).toBe(expectedGateway);
    expect(DEFAULT_GATEWAY_ENDPOINT).toMatch(/^https:\/\/.+\/$/);
  });

  it("exports verifier addresses; marks provisional when the profile leaves them unset", () => {
    const profile = manifest[MOLPHA_SDK_PROFILE];
    const provisional =
      MOLPHA_SDK_PROFILE === "dev" &&
      (profile.evmVerifier === null || profile.starknetSepolia === null);
    expect(MOLPHA_DEV_VERIFIERS_PROVISIONAL).toBe(provisional);

    expect(MOLPHA_VERIFIER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(MOLPHA_VERIFIER_STARKNET_SEPOLIA).toMatch(/^0x[0-9a-fA-F]+$/);

    if (!provisional) {
      expect(MOLPHA_VERIFIER_ADDRESS).toBe(profile.evmVerifier);
      expect(MOLPHA_VERIFIER_STARKNET_SEPOLIA).toBe(profile.starknetSepolia);
    } else {
      // Fallback to stable until the Attestation-interface redeploy fills the manifest.
      expect(MOLPHA_VERIFIER_ADDRESS).toBe(manifest.stable.evmVerifier);
      expect(MOLPHA_VERIFIER_STARKNET_SEPOLIA).toBe(manifest.stable.starknetSepolia);
    }
  });

  it("stable profile has concrete verifier addresses in the manifest", () => {
    expect(manifest.stable.evmVerifier).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(manifest.stable.starknetSepolia).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(manifest.stable.solanaProgramId).toBe(
      "MoLFGDpFoVnQgwbkTNScKPohCxhbfd61JjFrnotuwzh",
    );
    expect(manifest.stable.gatewayUrl).toContain("gateway.molpha.io");
    expect(manifest.dev.solanaProgramId).toBe(
      "chivcFQgxzwkpLvW41PV431HQ4dYpaW3povQH3AdpQt",
    );
    expect(manifest.dev.gatewayUrl).toContain("dev-gateway.molpha.io");
  });
});
