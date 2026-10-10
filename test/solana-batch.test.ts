/**
 * `MolphaSolanaClient.submitAttestations`: several attestations of one feed in one transaction,
 * with the Anchor account / method namespaces and the provider stubbed (no RPC).
 */
import { Program, Wallet, web3 } from "@anchor-lang/core";
import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "../src/core/encoding.js";
import type { Attestation } from "../src/core/types.js";
import {
  BatchTooLargeError,
  buildSubmitAttestationArgs,
  estimateSubmitBatchComputeUnits,
  estimateSubmitComputeUnits,
  estimateSubmitTransactionSize,
  maxAttestationsPerTransaction,
  MolphaSolanaClient,
  SUBMIT_INSTRUCTION_DATA_BYTES,
} from "../src/solana/client.js";
import { addressFromBytes } from "../src/solana/kit.js";
import { FIXTURE_SIGNER_BITS, PUBKEYS } from "./fixtures/registry12.js";

const nodeAddress = (i: number) => addressFromBytes(new Uint8Array(32).fill(0xc0 + i));
const SIGNERS = FIXTURE_SIGNER_BITS.length;

/** The 12-node message fixture (message.test.ts), 7 signers, at the given timestamp. */
function attestation(timestamp: number, over: Partial<Attestation["payload"]> = {}): Attestation {
  return {
    payload: {
      sourceId: "41b87cd1b00231a5caebdfbc3e352d92bb0ec116335cc3544278a4bac95071a7",
      value: "12cd90a4cd4351a26f2bd02583d791ae1b1a3285853a3315e718db8d7b85a62d",
      timestamp,
      registryVersion: 12,
      signaturesRequired: 5,
      ...over,
    },
    signature: {
      signersBitmap: "00".repeat(30) + "0fa8",
      s: "7fa5af9ccdd0e0a57b3c6741738e212f4bb9b0449b7b5be3e1c0b0875ea718b8",
      commitmentAddr: "5e69c8b56f51dfc5cd98e9f79b4a3c8b6ef02943",
    },
    value: "1",
    fresh: true,
  };
}

function harness() {
  const wallet = new Wallet(web3.Keypair.generate());
  const client = MolphaSolanaClient.create({
    connection: new web3.Connection("http://127.0.0.1:8899"),
    wallet,
  });
  const inner = client as unknown as {
    program: { account: Record<string, unknown>; methods: unknown };
    provider: { sendAndConfirm: unknown };
  };

  inner.program.account = {
    registry: {
      fetch: async () => ({
        version: 12,
        nodeCount: 12,
        redundancyBuffer: 2,
        nodes: Array.from({ length: 12 }, (_, i) => Array.from(new Uint8Array(32).fill(0xc0 + i))),
        graceActiveUntil: { toString: () => "0" },
        activeFrom: { toString: () => "1700000000" },
      }),
    },
    node: {
      fetchMultiple: async (addresses: web3.PublicKey[]) =>
        addresses.map((address) => {
          const index = Array.from({ length: 12 }, (_, i) => i).find((i) => nodeAddress(i) === address.toBase58())!;
          return {
            secp256k1PubkeyX: Array.from(hexToBytes(PUBKEYS[index]!.x)),
            secp256k1PubkeyY: Array.from(hexToBytes(PUBKEYS[index]!.y)),
          };
        }),
    },
  };

  const timestamps: number[] = [];
  const rpc = vi.fn(async () => "single-sig");
  inner.program.methods = {
    submitAttestation: (rawArgs: unknown) => {
      const args = rawArgs as { attestation: { payload: { timestamp: { toString(): string } } } };
      timestamps.push(Number(args.attestation.payload.timestamp.toString()));
      let accounts: Record<string, unknown> = {};
      let remaining: web3.AccountMeta[] = [];
      const builder = {
        accountsPartial: (a: Record<string, unknown>) => ((accounts = a), builder),
        remainingAccounts: (r: web3.AccountMeta[]) => ((remaining = r), builder),
        preInstructions: () => builder,
        rpc,
        // The same accounts, in the same order, as the program's instruction.
        instruction: async () =>
          new web3.TransactionInstruction({
            programId: new web3.PublicKey(client.programId),
            keys: [
              { pubkey: new web3.PublicKey(String(accounts.submitter)), isSigner: true, isWritable: true },
              { pubkey: new web3.PublicKey(String(accounts.registry)), isSigner: false, isWritable: false },
              { pubkey: new web3.PublicKey(String(accounts.feed)), isSigner: false, isWritable: true },
              { pubkey: new web3.PublicKey(String(accounts.protocolConfig)), isSigner: false, isWritable: false },
              { pubkey: new web3.PublicKey(String(accounts.systemProgram)), isSigner: false, isWritable: false },
              ...remaining,
            ],
            data: Buffer.alloc(SUBMIT_INSTRUCTION_DATA_BYTES),
          }),
      };
      return builder;
    },
  };

  const sent: web3.Transaction[] = [];
  const sendAndConfirm = vi.fn(async (tx: web3.Transaction) => (sent.push(tx), "batch-sig"));
  inner.provider.sendAndConfirm = sendAndConfirm;
  return { client, wallet, timestamps, rpc, sent, sendAndConfirm };
}

const FIRST = 1_705_257_421_000;
/** Seven signers: only two such attestations fit in a transaction. */
const batchOf = (n: number) => Array.from({ length: n }, (_, i) => attestation(FIRST + i * 250));
/** Three signers (nodes 0, 1 and 2), the usual quorum: three fit. */
const threeSigners = (timestamp: number): Attestation => ({
  ...attestation(timestamp, { signaturesRequired: 3 }),
  signature: { ...attestation(timestamp).signature, signersBitmap: "00".repeat(31) + "07" },
});
const trio = (n: number) => Array.from({ length: n }, (_, i) => threeSigners(FIRST + i * 250));

describe("MolphaSolanaClient.submitAttestations", () => {
  it("sends one transaction: a compute limit, then one instruction per attestation, oldest first", async () => {
    const { client, timestamps, sent, rpc } = harness();
    const [a, b, c] = trio(3) as [Attestation, Attestation, Attestation];

    const out = await client.submitAttestations([c, a, b]); // handed over out of order

    expect(timestamps).toEqual([a, b, c].map((x) => x.payload.timestamp));
    expect(sent).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalled();
    const [limit, ...submits] = sent[0]!.instructions;
    expect(limit!.programId.equals(web3.ComputeBudgetProgram.programId)).toBe(true);
    expect(submits).toHaveLength(3);
    expect(submits.every((ix) => ix.programId.toBase58() === client.programId)).toBe(true);
    expect(out).toMatchObject({ signature: "batch-sig", count: 3 });
    expect(out.feed).toBeTruthy();
  });

  it("sizes the compute limit to the whole batch", async () => {
    const { client, sent } = harness();
    await client.submitAttestations(trio(3));
    const { units } = web3.ComputeBudgetInstruction.decodeSetComputeUnitLimit(sent[0]!.instructions[0]!);
    expect(units).toBe(estimateSubmitBatchComputeUnits([3, 3, 3]));
    // One 10k margin for the transaction, not one per attestation.
    expect(units).toBeLessThan(3 * estimateSubmitComputeUnits(3));
    expect(estimateSubmitBatchComputeUnits([3])).toBe(estimateSubmitComputeUnits(3));
  });

  it("honors an explicit limit and adds a price only when asked", async () => {
    const plain = harness();
    await plain.client.submitAttestations(trio(2), { computeUnitLimit: 321_000 });
    expect(plain.sent[0]!.instructions).toHaveLength(3);
    expect(web3.ComputeBudgetInstruction.decodeSetComputeUnitLimit(plain.sent[0]!.instructions[0]!).units).toBe(321_000);

    const priced = harness();
    await priced.client.submitAttestations(trio(2), { priorityFeeMicroLamports: 777 });
    const [, price] = priced.sent[0]!.instructions;
    expect(web3.ComputeBudgetInstruction.decodeSetComputeUnitPrice(price!).microLamports).toBe(777n);
  });

  it("takes the plain path for a single attestation", async () => {
    const { client, rpc, sendAndConfirm } = harness();
    const out = await client.submitAttestations(trio(1));
    expect(rpc).toHaveBeenCalledOnce();
    expect(sendAndConfirm).not.toHaveBeenCalled();
    expect(out).toMatchObject({ signature: "single-sig", count: 1 });
  });

  it("refuses what cannot work before building anything", async () => {
    const { client, sendAndConfirm } = harness();
    await expect(client.submitAttestations([])).rejects.toThrow(/at least one/);
    await expect(client.submitAttestations([threeSigners(1), attestation(2, { signaturesRequired: 4 })])).rejects.toThrow(
      /same feed/,
    );
    await expect(
      client.submitAttestations([attestation(1), attestation(2, { sourceId: "aa".repeat(32) })]),
    ).rejects.toThrow(/same feed/);
    await expect(client.submitAttestations([attestation(5), attestation(5)])).rejects.toThrow(/not newer/);
    expect(sendAndConfirm).not.toHaveBeenCalled();
  });
});

describe("a batch that does not fit", () => {
  it("sends nothing and says how many do fit", async () => {
    const { client, sendAndConfirm } = harness();
    const fits = maxAttestationsPerTransaction(SIGNERS, { distinctSigners: SIGNERS });
    expect(fits).toBe(2);

    const error = await client.submitAttestations(batchOf(fits + 1)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BatchTooLargeError);
    expect(error).toBeInstanceOf(RangeError);
    const tooLarge = error as BatchTooLargeError;
    expect(tooLarge.fits).toBe(fits);
    expect(tooLarge.count).toBe(fits + 1);
    expect(tooLarge.size).toBeGreaterThan(tooLarge.limit);
    expect(tooLarge.limit).toBe(web3.PACKET_DATA_SIZE);
    expect(sendAndConfirm).not.toHaveBeenCalled();

    // The advice holds: the oldest `fits` go through.
    const retry = await client.submitAttestations(batchOf(fits));
    expect(retry.count).toBe(fits);
  });
});

describe("transaction size estimate", () => {
  it("matches a real serialization", () => {
    const keypair = web3.Keypair.generate();
    for (const count of [1, 2, 3]) {
      const tx = new web3.Transaction();
      tx.feePayer = keypair.publicKey;
      tx.recentBlockhash = "11111111111111111111111111111111";
      tx.add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }));
      // Three signers, all attestations on the same three Node accounts.
      const [registry, feed, config, program] = [0, 1, 2, 3].map(() => web3.Keypair.generate().publicKey);
      const nodes = [0, 1, 2].map(() => web3.Keypair.generate().publicKey);
      for (let i = 0; i < count; i++) {
        tx.add(
          new web3.TransactionInstruction({
            programId: program!,
            keys: [
              { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
              { pubkey: registry!, isSigner: false, isWritable: false },
              { pubkey: feed!, isSigner: false, isWritable: true },
              { pubkey: config!, isSigner: false, isWritable: false },
              { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
              ...nodes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
            ],
            data: Buffer.alloc(SUBMIT_INSTRUCTION_DATA_BYTES),
          }),
        );
      }
      const real = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      expect(estimateSubmitTransactionSize(count, 3)).toBe(real);
    }
  });

  it("uses the instruction data length the program's argument encoding produces", () => {
    const { client } = harness();
    const args = buildSubmitAttestationArgs(attestation(FIRST), {
      x: new Uint8Array(32),
      y: new Uint8Array(32),
    });
    const coder = (client as unknown as { program: Program }).program.coder.instruction;
    const encoded = coder.encode("submitAttestation", { args });
    expect(encoded.length).toBe(SUBMIT_INSTRUCTION_DATA_BYTES);
  });

  it("fits three attestations of three signers, and fewer as signers or fee instructions grow", () => {
    expect(maxAttestationsPerTransaction(3)).toBe(3);
    // The worst case: each attestation has a different signer triple out of five registry nodes.
    expect(maxAttestationsPerTransaction(3, { distinctSigners: 5 })).toBe(3);
    // A priority-fee instruction costs bytes the worst case does not have.
    expect(maxAttestationsPerTransaction(3, { distinctSigners: 5, priorityFee: true })).toBe(2);
    expect(maxAttestationsPerTransaction(4, { distinctSigners: 5 })).toBe(2);
    expect(maxAttestationsPerTransaction(5, { distinctSigners: 5 })).toBe(2);
  });
});
