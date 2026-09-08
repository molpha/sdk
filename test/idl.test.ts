/**
 * Offline guard for the vendored IDL: the Anchor client must build
 * `submit_attestation` with the SDK's PDAs and decode the zero-copy `Registry`.
 */
import { AnchorProvider, Program, Wallet, web3 } from "@anchor-lang/core";
import { describe, expect, it } from "vitest";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { MOLPHA_PROGRAM_ID } from "../src/core/constants.js";
import { hexToBytes } from "../src/core/encoding.js";
import type { DataUpdateResult } from "../src/core/types.js";
import { buildSubmitAttestationArgs } from "../src/solana/client.js";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/solana/kit.js";
import { feedPda, protocolConfigPda, registryPda } from "../src/solana/pdas.js";

const SUBMIT_ATTESTATION_DISCRIMINATOR = [238, 220, 255, 105, 183, 211, 40, 83];
const REGISTRY_DISCRIMINATOR = [47, 174, 110, 246, 184, 182, 252, 218];

const result: DataUpdateResult = {
  sourceId: "11".repeat(32),
  value: "1",
  valuePacked: "22".repeat(32),
  timestamp: 1_700_000_000,
  registryVersion: 7,
  signaturesRequired: 3,
  signersBitmap: "00".repeat(31) + "07",
  s: "33".repeat(32),
  commitmentAddr: "44".repeat(20),
  fresh: true,
};

function offlineProgram() {
  const provider = new AnchorProvider(
    new web3.Connection("http://127.0.0.1:8899"),
    new Wallet(web3.Keypair.generate()),
    { commitment: "confirmed" },
  );
  return { provider, program: new Program(MOLPHA_IDL, provider) };
}

describe("vendored IDL", () => {
  it("targets the expected program", () => {
    expect(MOLPHA_IDL.address).toBe(MOLPHA_PROGRAM_ID);
    expect(MOLPHA_PROGRAM_ADDRESS).toBe(MOLPHA_PROGRAM_ID);
  });

  it("exposes the consumer instructions and accounts", () => {
    const { program } = offlineProgram();
    expect(Object.keys(program.methods)).toEqual(
      expect.arrayContaining(["submitAttestation", "subscribe", "extendSubscription"]),
    );
    expect(Object.keys(program.account)).toEqual(
      expect.arrayContaining([
        "registry",
        "registryState",
        "feed",
        "plan",
        "subscription",
        "protocolConfig",
        "node",
      ]),
    );
  });

  it("builds submit_attestation with the SDK PDAs and argument layout", async () => {
    const { program, provider } = offlineProgram();
    const submitter = provider.wallet.publicKey;
    const ix = await program.methods
      .submitAttestation!(buildSubmitAttestationArgs(result))
      .accountsPartial({ submitter })
      .instruction();

    expect([...ix.data.subarray(0, 8)]).toEqual(SUBMIT_ATTESTATION_DISCRIMINATOR);
    // 32 source_id + 4 registry_version + 32 value + 8 canonical_timestamp + 1 signatures_required
    // + 32 agg_sig_s + 20 commitment + 32 signers_bitmap
    expect(ix.data.length).toBe(8 + 32 + 4 + 32 + 8 + 1 + 32 + 20 + 32);

    const programId = MOLPHA_PROGRAM_ADDRESS;
    const expectedKeys = [
      submitter.toBase58(),
      registryPda(result.registryVersion, programId),
      feedPda(hexToBytes(result.sourceId), result.signaturesRequired, submitter, programId),
      protocolConfigPda(programId),
      SYSTEM_PROGRAM_ADDRESS,
    ];
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(expectedKeys);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: false });
    expect(ix.keys[2]).toMatchObject({ isSigner: false, isWritable: true });
  });

  it("decodes the zero-copy Registry snapshot", () => {
    const { program } = offlineProgram();
    const body = Buffer.alloc(8208);
    body.writeUInt32LE(7, 0); // version
    body.writeUInt16LE(3, 4); // node_count
    body[6] = 2; // redundancy_buffer
    body[7] = 255; // bump
    for (let i = 0; i < 3; i++) body.fill(0xa0 + i, 8 + i * 32, 8 + (i + 1) * 32);
    body.writeBigInt64LE(123_456_789n, 8200); // grace_active_until

    const registry = program.coder.accounts.decode(
      "registry",
      Buffer.concat([Buffer.from(REGISTRY_DISCRIMINATOR), body]),
    );
    expect(registry.version).toBe(7);
    expect(registry.nodeCount).toBe(3);
    expect(registry.redundancyBuffer).toBe(2);
    expect(registry.bump).toBe(255);
    expect(registry.nodes).toHaveLength(256);
    expect(Buffer.from(registry.nodes[2]).toString("hex")).toBe("a2".repeat(32));
    expect(Buffer.from(registry.nodes[3]).toString("hex")).toBe("00".repeat(32));
    expect(registry.graceActiveUntil.toString()).toBe("123456789");
  });
});
