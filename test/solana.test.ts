import { web3 } from "@anchor-lang/core";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { u32le } from "../src/core/encoding.js";
import {
  type RegistryView,
  bitmapToIndices,
  resolveRemainingAccounts,
} from "../src/solana/accounts.js";
import { MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { addressFromBytes, type SolanaAccountMeta } from "../src/solana/kit.js";
import {
  feedPda,
  gatewayPda,
  nodePda,
  planPda,
  protocolConfigPda,
  registryPda,
  registryStatePda,
  subscriptionPda,
} from "../src/solana/pdas.js";

const programId = address(MOLPHA_PROGRAM_ADDRESS);
const OWNER = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";

/** bits 0,1,2 set in the 32-byte big-endian word. */
const BITMAP_012 = "00".repeat(31) + "07";

const nodeAddress = (i: number) => addressFromBytes(new Uint8Array(32).fill(0xa0 + i));

const registry: RegistryView = {
  version: 5,
  nodeCount: 3,
  redundancyBuffer: 2,
  nodes: [nodeAddress(0), nodeAddress(1), nodeAddress(2)],
  graceActiveUntil: 0n,
};

const keys = (metas: SolanaAccountMeta[]) => metas.map((m) => m.pubkey.toBase58());

function pdaWith(seeds: Uint8Array[]): string {
  const [pda] = web3.PublicKey.findProgramAddressSync(
    seeds.map((s) => Buffer.from(s)),
    new web3.PublicKey(MOLPHA_PROGRAM_ADDRESS),
  );
  return pda.toBase58();
}

describe("bitmapToIndices", () => {
  it("reads set bits from a 32-byte big-endian word", () => {
    expect(bitmapToIndices(BITMAP_012)).toEqual([0, 1, 2]);
  });
});

describe("resolveRemainingAccounts", () => {
  it("maps signer bits to the registry snapshot's Node addresses, ascending", () => {
    const metas = resolveRemainingAccounts(BITMAP_012, registry);
    expect(keys(metas)).toEqual([nodeAddress(0), nodeAddress(1), nodeAddress(2)]);
    expect(metas.every((m) => !m.isSigner && !m.isWritable)).toBe(true);
  });

  it("skips unset bits", () => {
    const bitmap = "00".repeat(31) + "05"; // bits 0 and 2
    expect(keys(resolveRemainingAccounts(bitmap, registry))).toEqual([
      nodeAddress(0),
      nodeAddress(2),
    ]);
  });

  it("rejects a signer bit at or beyond node_count", () => {
    const bitmap = "00".repeat(31) + "0f"; // bits 0..3, but node_count == 3
    expect(() => resolveRemainingAccounts(bitmap, registry)).toThrow(/InvalidNodeIndex.*bit 3/);
  });
});

describe("PDA derivations", () => {
  it("protocolConfig / registryState / registry(version)", () => {
    expect(protocolConfigPda(programId)).toBe(pdaWith([Buffer.from("molpha_config")]));
    expect(registryStatePda(programId)).toBe(pdaWith([Buffer.from("molpha_registry")]));
    expect(registryPda(7, programId)).toBe(
      pdaWith([Buffer.from("molpha_registry"), u32le(7)]),
    );
    expect(registryPda(7, programId)).not.toBe(registryStatePda(programId));
  });

  it("node(owner) / gateway(authority) / subscription(owner) / plan(type)", () => {
    const ownerBytes = new web3.PublicKey(OWNER).toBytes();
    expect(nodePda(OWNER, programId)).toBe(pdaWith([Buffer.from("molpha_node"), ownerBytes]));
    expect(gatewayPda(OWNER, programId)).toBe(
      pdaWith([Buffer.from("molpha_gateway"), ownerBytes]),
    );
    expect(subscriptionPda(OWNER, programId)).toBe(
      pdaWith([Buffer.from("molpha_subscription"), ownerBytes]),
    );
    expect(planPda(2, programId)).toBe(pdaWith([Buffer.from("molpha_plan"), Uint8Array.of(2)]));
  });

  it("feed(sourceId, signaturesRequired, submitter)", () => {
    const sourceId = new Uint8Array(32).fill(0x11);
    const submitterBytes = new web3.PublicKey(OWNER).toBytes();
    expect(feedPda(sourceId, 3, OWNER, programId)).toBe(
      pdaWith([Buffer.from("molpha_feed"), sourceId, Uint8Array.of(3), submitterBytes]),
    );
    expect(feedPda(sourceId, 3, OWNER, programId)).not.toBe(feedPda(sourceId, 4, OWNER, programId));
    expect(() => feedPda(new Uint8Array(31), 3, OWNER, programId)).toThrow();
    expect(() => feedPda(sourceId, 256, OWNER, programId)).toThrow(/u8/);
  });
});
