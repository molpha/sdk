/**
 * The provider counts toward `signaturesRequired` (at most one provider bit), so a provider round
 * is `signaturesRequired - 1` nodes plus the provider and its committee is drawn with that node
 * quorum. The client-side mirrors of that rule: `nodeQuorum`, the provider-round draw,
 * `eligibleSetSize` and the Solana signer-count check.
 */
import { Program, Wallet, web3 } from "@anchor-lang/core";
import { describe, expect, it, vi } from "vitest";
import { bytesToHex } from "../src/core/encoding.js";
import {
  bitmapBitSet,
  deriveSelectionBitmap,
  hasProviderBit,
  nodeQuorum,
  providerBitCount,
} from "../src/core/selection.js";
import type { Attestation } from "../src/core/types.js";
import { eligibleSetSize } from "../src/gateway/x402.js";
import { assertSignerCount, MolphaSolanaClient } from "../src/solana/client.js";
import { computeCoalitionKey } from "../src/core/coalition.js";
import { MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { PUBKEYS } from "./fixtures/registry12.js";
import { accountInfo, registryAccountBytes } from "./fixtures/registry-bytes.js";

const bitmapOf = (...bits: number[]): Uint8Array => {
  const out = new Uint8Array(32);
  for (const bit of bits) out[31 - (bit >> 3)]! |= 1 << (bit & 7);
  return out;
};
const bitsOf = (bitmap: Uint8Array): number[] =>
  Array.from({ length: 256 }, (_, bit) => bit).filter((bit) => bitmapBitSet(bitmap, bit));
const registry = { version: 12, redundancyBuffer: 2 };

describe("nodeQuorum", () => {
  it("is one less when the provider signs, from a flag or from the bitmap", () => {
    expect(nodeQuorum(5, false)).toBe(5);
    expect(nodeQuorum(5, true)).toBe(4);
    expect(nodeQuorum(5, bitmapOf(0, 1, 2, 3, 4))).toBe(5);
    expect(nodeQuorum(5, bitmapOf(0, 1, 2, 3, 65))).toBe(4);
    expect(nodeQuorum(5, bitmapOf(0, 1, 2, 3, 255))).toBe(4);
    expect(nodeQuorum(0, true)).toBe(0); // never negative
  });

  it("counts provider bits from bit 64, not from bit 63", () => {
    expect(hasProviderBit(bitmapOf(63))).toBe(false);
    expect(hasProviderBit(bitmapOf(64))).toBe(true);
    expect(providerBitCount(bitmapOf(0, 63, 64, 65, 255))).toBe(3);
    expect(providerBitCount(new Uint8Array(32))).toBe(0);
  });
});

describe("the provider-round draw", () => {
  const live12 = Array.from({ length: 12 }, (_, i) => i);
  const ts = 1_705_257_421_000;

  it("is the draw of the node quorum, and the committee draw keeps the wire threshold", () => {
    for (let i = 0; i < 32; i++) {
      const source = new Uint8Array(32).fill(i);
      const provider = deriveSelectionBitmap(source, 3, 12, 5, 2, ts, live12, true);
      expect(bytesToHex(provider)).toBe(
        bytesToHex(deriveSelectionBitmap(source, 3, 12, 4, 2, ts, live12)),
      );
      expect(bitsOf(provider)).toHaveLength(6); // 4 + buffer 2
      expect(bitsOf(deriveSelectionBitmap(source, 3, 12, 5, 2, ts, live12))).toHaveLength(7);
    }
  });

  it("is not contained in the committee draw, so a round is judged by its own", () => {
    // 4 nodes, no buffer: the committee of 3 is the complement of one node, the provider round of
    // 2 is sampled directly, and the two disagree for some windows.
    let disagreed = 0;
    for (let window = 0; window < 256; window++) {
      const source = new Uint8Array(32).fill(3);
      const at = window * 1000;
      const committee = bitsOf(deriveSelectionBitmap(source, 1, 4, 3, 0, at));
      const provider = bitsOf(deriveSelectionBitmap(source, 1, 4, 3, 0, at, undefined, true));
      expect(provider).toHaveLength(2);
      if (provider.some((bit) => !committee.includes(bit))) disagreed++;
    }
    expect(disagreed).toBeGreaterThan(0);
  });
});

describe("eligibleSetSize", () => {
  it("fetches from one node fewer in a provider round", () => {
    const reg = { nodeCount: 12, redundancyBuffer: 2 };
    expect(eligibleSetSize(5, reg)).toBe(7);
    expect(eligibleSetSize(5, reg, true)).toBe(6);
    expect(eligibleSetSize(5, reg, true)).toBe(eligibleSetSize(4, reg));
    // The buffer cannot exceed the live members either way.
    expect(eligibleSetSize(12, reg, true)).toBe(12);
    // `nodeCount` is the gateway's live-node count: five live nodes (six slots, one a hole).
    expect(eligibleSetSize(5, { nodeCount: 5, redundancyBuffer: 2 }, true)).toBe(5);
    expect(eligibleSetSize(4, { nodeCount: 5, redundancyBuffer: 2 })).toBe(5);
  });
});

describe("assertSignerCount", () => {
  it("counts the provider toward the threshold", () => {
    expect(() => assertSignerCount([0, 1, 2, 3, 4], 5, registry)).not.toThrow();
    expect(() => assertSignerCount([0, 1, 2, 3, 65], 5, registry)).not.toThrow();
    expect(() => assertSignerCount([0, 1, 2, 65], 5, registry)).toThrow(/QuorumBelowThreshold/);
    expect(() => assertSignerCount([65], 3, registry)).toThrow(/QuorumBelowThreshold/);
  });

  it("bounds the nodes by the node quorum plus the buffer, and the provider rides along", () => {
    // Quorum 5, buffer 2: seven nodes without a provider ...
    expect(() => assertSignerCount([0, 1, 2, 3, 4, 5, 6], 5, registry)).not.toThrow();
    expect(() => assertSignerCount([0, 1, 2, 3, 4, 5, 6, 7], 5, registry)).toThrow(
      /CreditedExceedsSelection/,
    );
    // ... and six nodes with one: (5 - 1) + 2.
    expect(() => assertSignerCount([0, 1, 2, 3, 4, 5, 65], 5, registry)).not.toThrow();
    expect(() => assertSignerCount([0, 1, 2, 3, 4, 5, 6, 65], 5, registry)).toThrow(
      /CreditedExceedsSelection/,
    );
  });

  it("refuses a second provider bit however many nodes sign", () => {
    expect(() => assertSignerCount([0, 1, 2, 3, 65, 66], 5, registry)).toThrow(
      /InvalidSignersBitmap/,
    );
    expect(() => assertSignerCount([0, 1, 2, 65, 66], 4, registry)).toThrow(/InvalidSignersBitmap/);
  });
});

describe("MolphaSolanaClient.submitAttestation with a provider bit", () => {
  // Ten nodes, then provider slots 0 (reserved, a hole), 1 (bit 65) and 2 (bit 66), keys from the
  // fixture.
  const record = (i: number) => ({
    account: new Uint8Array(32).fill(0x10 + i),
    x: PUBKEYS[i]!.x,
    y: PUBKEYS[i]!.y,
  });
  const registryBytes = registryAccountBytes({
    version: 12,
    redundancyBuffer: 2,
    nodes: Array.from({ length: 10 }, (_, i) => record(i)),
    providers: [null, record(10), record(11)],
  });

  function harness() {
    const client = MolphaSolanaClient.create({
      connection: new web3.Connection("http://127.0.0.1:8899"),
      wallet: new Wallet(web3.Keypair.generate()),
    });
    const program = (client as unknown as { program: Program }).program as unknown as {
      methods: unknown;
      provider: { connection: { getAccountInfo: unknown } };
    };
    program.provider.connection.getAccountInfo = vi.fn(async () =>
      accountInfo(registryBytes, MOLPHA_PROGRAM_ADDRESS),
    );
    const captured: { args?: any; remaining?: web3.AccountMeta[] } = {};
    const rpc = vi.fn(async () => "sig");
    program.methods = {
      submitAttestation: (args: unknown) => {
        captured.args = args;
        const builder = {
          accountsPartial: () => builder,
          remainingAccounts: (remaining: web3.AccountMeta[]) => ((captured.remaining = remaining), builder),
          preInstructions: () => builder,
          rpc,
        };
        return builder;
      },
    };
    return { client, captured, rpc };
  }

  const attestation = (bits: number[], signaturesRequired = 5): Attestation => ({
    payload: {
      sourceId: "41b87cd1b00231a5caebdfbc3e352d92bb0ec116335cc3544278a4bac95071a7",
      value: "12cd90a4cd4351a26f2bd02583d791ae1b1a3285853a3315e718db8d7b85a62d",
      timestamp: 1_705_257_421,
      registryVersion: 12,
      signaturesRequired,
    },
    signature: {
      signersBitmap: bytesToHex(bitmapOf(...bits)),
      s: "7fa5af9ccdd0e0a57b3c6741738e212f4bb9b0449b7b5be3e1c0b0875ea718b8",
      commitmentAddr: "5e69c8b56f51dfc5cd98e9f79b4a3c8b6ef02943",
    },
    value: "1",
    fresh: true,
  });
  const coalitionKey = { x: new Uint8Array(32).fill(1), y: new Uint8Array(32).fill(2) };

  it("accepts four nodes and the provider for a quorum of five, summing the provider's record key", async () => {
    const { client, captured, rpc } = harness();
    await client.submitAttestation(attestation([0, 1, 2, 3, 65]));
    expect(rpc).toHaveBeenCalledOnce();
    expect(captured.remaining).toBeUndefined();
    // Bit 65 is provider slot 1, whose record holds key 10.
    const expected = computeCoalitionKey([0, 1, 2, 3, 10].map((i) => PUBKEYS[i]!));
    expect(Uint8Array.from(captured.args.coalitionKey.x)).toEqual(expected.x);
    expect(Uint8Array.from(captured.args.coalitionKey.y)).toEqual(expected.y);
  });

  it("refuses the reserved provider slot and a slot past the provider table", async () => {
    const { client, rpc } = harness();
    await expect(client.submitAttestation(attestation([0, 1, 2, 3, 64]))).rejects.toThrow(
      /bit 64 names no live member/,
    );
    await expect(client.submitAttestation(attestation([0, 1, 2, 3, 67]))).rejects.toThrow(
      /bit 67 names no live member/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses three nodes and the provider, and two providers, before sending", async () => {
    const { client, rpc } = harness();
    await expect(
      client.submitAttestation(attestation([0, 1, 2, 65]), { coalitionKey }),
    ).rejects.toThrow(/QuorumBelowThreshold/);
    await expect(
      client.submitAttestation(attestation([0, 1, 2, 3, 65, 66]), { coalitionKey }),
    ).rejects.toThrow(/InvalidSignersBitmap/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
