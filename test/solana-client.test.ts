/**
 * `MolphaSolanaClient.submitAttestation`: coalition key from the registry records, no signer
 * accounts, and argument shape, with the registry read and the method namespace stubbed (no RPC).
 */
import { Program, Wallet, web3 } from "@anchor-lang/core";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it, vi } from "vitest";
import { bytesToHex } from "../src/core/encoding.js";
import type { Attestation } from "../src/core/types.js";
import { estimateSubmitComputeUnits, MolphaSolanaClient } from "../src/solana/client.js";
import { MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { FIXTURE_SIGNER_BITS, PUBKEYS, RUST_VECTORS } from "./fixtures/registry12.js";
import { accountInfo, registryAccountBytes } from "./fixtures/registry-bytes.js";

/** The 12-node message fixture (message.test.ts), with the 7-signer bitmap 4008. */
const result: Attestation = {
  payload: {
    sourceId: "41b87cd1b00231a5caebdfbc3e352d92bb0ec116335cc3544278a4bac95071a7",
    value: "12cd90a4cd4351a26f2bd02583d791ae1b1a3285853a3315e718db8d7b85a62d",
    timestamp: 1_705_257_421,
    registryVersion: 12,
    signaturesRequired: 5,
  },
  signature: {
    signersBitmap: "00".repeat(30) + "0fa8",
    s: "7fa5af9ccdd0e0a57b3c6741738e212f4bb9b0449b7b5be3e1c0b0875ea718b8",
    commitmentAddr: "5e69c8b56f51dfc5cd98e9f79b4a3c8b6ef02943",
  },
  value: "1",
  fresh: true,
};

/** The 12-node registry of the fixture, version 12; `hole` leaves that slot empty. */
function registryAccount(buffer = 2, opts: { hole?: number; owner?: string } = {}) {
  const data = registryAccountBytes({
    version: 12,
    redundancyBuffer: buffer,
    nodes: Array.from({ length: 12 }, (_, i) =>
      i === opts.hole
        ? null
        : { account: new Uint8Array(32).fill(0xc0 + i), x: PUBKEYS[i]!.x, y: PUBKEYS[i]!.y },
    ),
  });
  return accountInfo(data, opts.owner ?? MOLPHA_PROGRAM_ADDRESS);
}

function harness(opts: { registry?: web3.AccountInfo<Buffer> | null } = {}) {
  const wallet = new Wallet(web3.Keypair.generate());
  const client = MolphaSolanaClient.create({
    connection: new web3.Connection("http://127.0.0.1:8899"),
    wallet,
  });
  const program = (client as unknown as { program: Program }).program as unknown as {
    account: Record<string, unknown>;
    methods: unknown;
    provider: { connection: { getAccountInfo: unknown } };
  };

  // The program reads signer keys from the registry: nothing may fetch a Node account to submit.
  const fetchMultiple = vi.fn(async () => {
    throw new Error("submit must not read Node accounts");
  });
  const registryFetch = vi.fn(async (address: web3.PublicKey) => {
    void address;
    return opts.registry === undefined ? registryAccount() : opts.registry;
  });
  program.provider.connection.getAccountInfo = registryFetch;
  program.account = { node: { fetchMultiple, fetch: fetchMultiple } };

  const captured: { args?: any; remaining?: web3.AccountMeta[]; accounts?: any; pre?: unknown[] } = {};
  const rpc = vi.fn(async () => "sig");
  program.methods = {
    submitAttestation: (args: unknown) => {
      captured.args = args;
      const builder = {
        accountsPartial: (accounts: unknown) => ((captured.accounts = accounts), builder),
        remainingAccounts: (remaining: web3.AccountMeta[]) => ((captured.remaining = remaining), builder),
        preInstructions: (pre: unknown[]) => ((captured.pre = pre), builder),
        rpc,
      };
      return builder;
    },
  };
  return { client, captured, rpc, fetchMultiple, wallet, registryFetch };
}

describe("MolphaSolanaClient.submitAttestation", () => {
  it("passes no signer accounts and the coalition key summed from the registry records", async () => {
    const { client, captured, rpc, fetchMultiple, wallet, registryFetch } = harness();
    const out = await client.submitAttestation(result);

    expect(out.signature).toBe("sig");
    expect(rpc).toHaveBeenCalledOnce();
    // The program refuses remaining accounts (`UnexpectedSignerAccounts`).
    expect(captured.remaining).toBeUndefined();
    expect(fetchMultiple).not.toHaveBeenCalled();
    expect(String(captured.accounts.registry)).toBe(registryFetch.mock.calls[0]![0].toBase58());
    expect(FIXTURE_SIGNER_BITS).toHaveLength(7);

    // Coalition key = Rust `molpha_verifier::coalition_key` over the same seven signers.
    const expected = RUST_VECTORS[0]!;
    expect(bytesToHex(Uint8Array.from(captured.args.coalitionKey.x))).toBe(expected.x);
    expect(bytesToHex(Uint8Array.from(captured.args.coalitionKey.y))).toBe(expected.y);

    // Attestation shape and accounts.
    expect(captured.args.rawValue).toBeNull();
    expect(captured.args.attestation.payload.signaturesRequired).toBe(5);
    expect(bytesToHex(Uint8Array.from(captured.args.attestation.payload.value))).toBe(
      result.payload.value,
    );
    expect(String(captured.accounts.submitter)).toBe(wallet.publicKey.toBase58());
    expect(String(captured.accounts.feed)).toBe(out.feed);
    expect(captured.pre).toHaveLength(1); // compute-unit limit
    expect(out.feed).toBeTruthy();
  });

  it("uses an explicit coalition key as given", async () => {
    const { client, captured } = harness();
    const coalitionKey = { x: new Uint8Array(32).fill(1), y: new Uint8Array(32).fill(2) };
    await client.submitAttestation(result, { coalitionKey });
    expect(captured.args.coalitionKey).toEqual({
      x: Array.from(coalitionKey.x),
      y: Array.from(coalitionKey.y),
    });
  });

  it("forwards rawValue for hashed values", async () => {
    const { client, captured } = harness();
    const rawValue = new Uint8Array([1, 2, 3]);
    const hashedResult = {
      ...result,
      payload: { ...result.payload, value: bytesToHex(keccak_256(rawValue)) },
    };
    await client.submitAttestation(hashedResult, { rawValue });
    expect(Buffer.from(captured.args.rawValue).toString("hex")).toBe("010203");
  });

  it("refuses a signer bit on a hole of the registry", async () => {
    const { client, rpc } = harness({ registry: registryAccount(2, { hole: 7 }) });
    await expect(client.submitAttestation(result)).rejects.toThrow(/bit 7 names no live member/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a missing registry, or one another program owns", async () => {
    const { client, rpc } = harness({ registry: null });
    await expect(client.submitAttestation(result)).rejects.toThrow(/Registry version 12 .* does not exist/);
    const other = web3.Keypair.generate().publicKey.toBase58();
    const { client: client2 } = harness({ registry: registryAccount(2, { owner: other }) });
    await expect(client2.submitAttestation(result)).rejects.toThrow(/is owned by/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an account that is not a Registry", async () => {
    const info = registryAccount();
    info.data[0] = info.data[0]! ^ 0xff;
    const { client } = harness({ registry: info });
    await expect(client.submitAttestation(result)).rejects.toThrow(/is not a Registry account/);
  });

  it("mirrors the program's signer-count bounds before sending", async () => {
    const { client, rpc } = harness({ registry: registryAccount(1) }); // 7 signers > 5 + 1
    await expect(client.submitAttestation(result)).rejects.toThrow(/CreditedExceedsSelection/);
    const { client: client2 } = harness();
    await expect(
      client2.submitAttestation({
        ...result,
        payload: { ...result.payload, signaturesRequired: 8 },
      }),
    ).rejects.toThrow(/QuorumBelowThreshold/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a signer bit beyond the registry's node_count", async () => {
    const { client } = harness();
    await expect(
      client.submitAttestation({
        ...result,
        signature: { ...result.signature, signersBitmap: "00".repeat(29) + "010fa8" },
      }),
    ).rejects.toThrow(/InvalidNodeIndex/);
  });
});

/** Decodes the compute-budget instruction's argument: [discriminator, u32 units] or [.., u64 price]. */
function budgetArg(ix: any, kind: "limit" | "price"): number {
  const data = Buffer.from(ix.data);
  expect(data[0]).toBe(kind === "limit" ? 2 : 3);
  return kind === "limit" ? data.readUInt32LE(1) : Number(data.readBigUInt64LE(1));
}

describe("compute budget", () => {
  it("sizes the limit to the aggregate instead of requesting the 1.4M maximum", async () => {
    const { client, captured } = harness();
    await client.submitAttestation(result); // seven signers
    expect(captured.pre).toHaveLength(1);
    const limit = budgetArg(captured.pre![0], "limit");
    expect(limit).toBe(estimateSubmitComputeUnits(7));
    expect(limit).toBeLessThan(250_000);
    // Above what the program benchmark measures for the whole transaction at 8 signers (~119k).
    expect(estimateSubmitComputeUnits(8)).toBeGreaterThan(119_000 * 1.15);
  });

  it("covers the benchmark and stays inside the transaction maximum", () => {
    for (const [signers, measured] of [[8, 119_178], [12, 157_382], [18, 210_020]] as const) {
      expect(estimateSubmitComputeUnits(signers)).toBeGreaterThan(measured * 1.15);
    }
    expect(estimateSubmitComputeUnits(200)).toBe(1_400_000);
    expect(estimateSubmitComputeUnits(0)).toBe(1_400_000);
  });

  it("honors an explicit limit", async () => {
    const { client, captured } = harness();
    await client.submitAttestation(result, { computeUnitLimit: 300_000 });
    expect(budgetArg(captured.pre![0], "limit")).toBe(300_000);
  });

  it("adds a compute-unit price only when asked", async () => {
    const { client, captured } = harness();
    await client.submitAttestation(result, { priorityFeeMicroLamports: 2_500 });
    expect(captured.pre).toHaveLength(2);
    expect(budgetArg(captured.pre![1], "price")).toBe(2_500);
    await expect(
      client.submitAttestation(result, { priorityFeeMicroLamports: -1 }),
    ).rejects.toThrow(/priorityFeeMicroLamports/);
  });

  it("derives an automatic fee from recent prioritization fees, capped, and reuses it briefly", async () => {
    const { client, captured } = harness();
    const getFees = vi.fn(async () =>
      [0, 0, 100, 200, 300, 400, 500, 600, 700, 5_000_000].map((fee, slot) => ({ slot, prioritizationFee: fee })),
    );
    (client as any).provider.connection.getRecentPrioritizationFees = getFees;
    await client.submitAttestation(result, { priorityFeeMicroLamports: "auto" });
    // 75th percentile of ten samples is the 8th smallest (index 7): 600... capped fees apply to outliers only.
    expect(budgetArg(captured.pre![1], "price")).toBe(600);
    await client.submitAttestation(result, { priorityFeeMicroLamports: "auto" });
    expect(getFees).toHaveBeenCalledTimes(1);
  });

  it("an unreadable fee market does not stop a submit", async () => {
    const { client, captured, rpc } = harness();
    (client as any).provider.connection.getRecentPrioritizationFees = vi.fn(async () => {
      throw new Error("rpc down");
    });
    await client.submitAttestation(result, { priorityFeeMicroLamports: "auto" });
    expect(rpc).toHaveBeenCalledOnce();
    expect(captured.pre).toHaveLength(1);
  });
});

describe("registry and signer-key caching", () => {
  it("reads the registry once for many submits", async () => {
    const { client, registryFetch } = harness();
    for (let i = 0; i < 5; i++) await client.submitAttestation(result);
    expect(registryFetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent submits into one read", async () => {
    const { client, registryFetch, rpc } = harness();
    await Promise.all(Array.from({ length: 20 }, () => client.submitAttestation(result)));
    expect(rpc).toHaveBeenCalledTimes(20);
    expect(registryFetch).toHaveBeenCalledTimes(1);
  });

  it("sums a changed signer set from the same registry read", async () => {
    const { client, registryFetch, captured } = harness();
    await client.submitAttestation(result);
    const full = captured.args.coalitionKey;
    // Drop one signer (bit 3 of 4008 = 0b111110101000): still a valid 6-signer set for quorum 5.
    const without = {
      ...result,
      signature: { ...result.signature, signersBitmap: "00".repeat(30) + "0fa0" },
    };
    await client.submitAttestation(without);
    expect(registryFetch).toHaveBeenCalledTimes(1);
    expect(captured.args.coalitionKey).not.toEqual(full);
  });

  it("does not remember a failed read", async () => {
    const { client, registryFetch } = harness();
    registryFetch.mockRejectedValueOnce(new Error("rpc down"));
    await expect(client.submitAttestation(result)).rejects.toThrow(/rpc down/);
    await client.submitAttestation(result);
    expect(registryFetch).toHaveBeenCalledTimes(2);
  });

  it("gives a client with a different registry version its own entry", async () => {
    const { client, registryFetch } = harness();
    await client.submitAttestation(result);
    await client.submitAttestation({ ...result, payload: { ...result.payload, registryVersion: 13 } });
    expect(registryFetch).toHaveBeenCalledTimes(2);
  });
});
