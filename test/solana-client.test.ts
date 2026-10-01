/**
 * `MolphaSolanaClient.submitAttestation`: remaining accounts, coalition key and argument
 * shape, with the Anchor account / method namespaces stubbed (no RPC).
 */
import { AnchorProvider, Program, Wallet, web3 } from "@anchor-lang/core";
import { describe, expect, it, vi } from "vitest";
import { bytesToHex, hexToBytes } from "../src/core/encoding.js";
import type { DataUpdateResult } from "../src/core/types.js";
import { MolphaSolanaClient } from "../src/solana/client.js";
import { addressFromBytes } from "../src/solana/kit.js";
import { FIXTURE_SIGNER_BITS, PUBKEYS, RUST_VECTORS } from "./fixtures/registry12.js";

const nodeAddress = (i: number) => addressFromBytes(new Uint8Array(32).fill(0xc0 + i));

/** The 12-node message fixture (message.test.ts), with the 7-signer bitmap 4008. */
const result: DataUpdateResult = {
  sourceId: "41b87cd1b00231a5caebdfbc3e352d92bb0ec116335cc3544278a4bac95071a7",
  value: "1",
  valuePacked: "12cd90a4cd4351a26f2bd02583d791ae1b1a3285853a3315e718db8d7b85a62d",
  timestamp: 1_705_257_421,
  registryVersion: 12,
  signaturesRequired: 5,
  signersBitmap: "00".repeat(30) + "0fa8",
  s: "7fa5af9ccdd0e0a57b3c6741738e212f4bb9b0449b7b5be3e1c0b0875ea718b8",
  commitmentAddr: "5e69c8b56f51dfc5cd98e9f79b4a3c8b6ef02943",
  fresh: true,
};

function registryAccount(buffer = 2) {
  return {
    version: 12,
    nodeCount: 12,
    redundancyBuffer: buffer,
    nodes: Array.from({ length: 12 }, (_, i) => Array.from(new Uint8Array(32).fill(0xc0 + i))),
    graceActiveUntil: { toString: () => "0" },
    activeFrom: { toString: () => "1700000000" },
  };
}

function harness(opts: { registry?: ReturnType<typeof registryAccount>; missingNode?: number } = {}) {
  const wallet = new Wallet(web3.Keypair.generate());
  const client = MolphaSolanaClient.create({
    connection: new web3.Connection("http://127.0.0.1:8899"),
    wallet,
  });
  const program = (client as unknown as { program: Program }).program as unknown as {
    account: Record<string, unknown>;
    methods: unknown;
  };

  const fetchMultiple = vi.fn(async (addresses: web3.PublicKey[]) =>
    addresses.map((address) => {
      const index = Array.from({ length: 12 }, (_, i) => i).find(
        (i) => nodeAddress(i) === address.toBase58(),
      )!;
      if (index === opts.missingNode) return null;
      return {
        secp256k1PubkeyX: Array.from(hexToBytes(PUBKEYS[index]!.x)),
        secp256k1PubkeyY: Array.from(hexToBytes(PUBKEYS[index]!.y)),
      };
    }),
  );
  program.account = {
    registry: { fetch: vi.fn(async () => opts.registry ?? registryAccount()) },
    node: { fetchMultiple },
  };

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
  return { client, captured, rpc, fetchMultiple, wallet };
}

describe("MolphaSolanaClient.submitAttestation", () => {
  it("passes the signer Node accounts in bit order and the summed coalition key", async () => {
    const { client, captured, rpc, fetchMultiple, wallet } = harness();
    const out = await client.submitAttestation(result);

    expect(out.signature).toBe("sig");
    expect(rpc).toHaveBeenCalledOnce();
    // One read-only Node account per set bit, ascending.
    expect(captured.remaining!.map((m) => m.pubkey.toBase58())).toEqual(
      FIXTURE_SIGNER_BITS.map(nodeAddress),
    );
    expect(captured.remaining!.every((m) => !m.isSigner && !m.isWritable)).toBe(true);
    expect(fetchMultiple.mock.calls[0]![0].map((k: web3.PublicKey) => k.toBase58())).toEqual(
      FIXTURE_SIGNER_BITS.map(nodeAddress),
    );

    // Coalition key = Rust `molpha_verifier::coalition_key` over the same seven signers.
    const expected = RUST_VECTORS[0]!;
    expect(bytesToHex(Uint8Array.from(captured.args.coalitionKey.x))).toBe(expected.x);
    expect(bytesToHex(Uint8Array.from(captured.args.coalitionKey.y))).toBe(expected.y);

    // Attestation shape and accounts.
    expect(captured.args.rawValue).toBeNull();
    expect(captured.args.attestation.payload.signaturesRequired).toBe(5);
    expect(bytesToHex(Uint8Array.from(captured.args.attestation.payload.value))).toBe(
      result.valuePacked,
    );
    expect(String(captured.accounts.submitter)).toBe(wallet.publicKey.toBase58());
    expect(String(captured.accounts.feed)).toBe(out.feed);
    expect(captured.pre).toHaveLength(1); // compute-unit limit
    expect(out.feed).toBeTruthy();
  });

  it("uses an explicit coalition key without fetching Node accounts", async () => {
    const { client, captured, fetchMultiple } = harness();
    const coalitionKey = { x: new Uint8Array(32).fill(1), y: new Uint8Array(32).fill(2) };
    await client.submitAttestation(result, { coalitionKey });
    expect(fetchMultiple).not.toHaveBeenCalled();
    expect(captured.args.coalitionKey).toEqual({
      x: Array.from(coalitionKey.x),
      y: Array.from(coalitionKey.y),
    });
  });

  it("forwards rawValue for hashed values", async () => {
    const { client, captured } = harness();
    await client.submitAttestation(result, { rawValue: new Uint8Array([1, 2, 3]) });
    expect(Buffer.from(captured.args.rawValue).toString("hex")).toBe("010203");
  });

  it("fails clearly when a signer's Node account is missing", async () => {
    const { client, rpc } = harness({ missingNode: 7 });
    await expect(client.submitAttestation(result)).rejects.toThrow(/does not exist/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("mirrors the program's signer-count bounds before sending", async () => {
    const { client, rpc } = harness({ registry: registryAccount(1) }); // 7 signers > 5 + 1
    await expect(client.submitAttestation(result)).rejects.toThrow(/CreditedExceedsSelection/);
    const { client: client2 } = harness();
    await expect(
      client2.submitAttestation({ ...result, signaturesRequired: 8 }),
    ).rejects.toThrow(/QuorumBelowThreshold/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a signer bit beyond the registry's node_count", async () => {
    const { client } = harness();
    await expect(
      client.submitAttestation({ ...result, signersBitmap: "00".repeat(29) + "010fa8" }),
    ).rejects.toThrow(/InvalidNodeIndex/);
  });
});

