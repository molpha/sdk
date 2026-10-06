/**
 * Offline guard for the vendored IDL (program 3d01170, "Epoch settlements"): the Anchor
 * client must build `submit_attestation` with the SDK's PDAs and decode the program's
 * zero-copy `Registry` and borsh account layouts.
 */
import { AnchorProvider, BN, Program, Wallet, web3 } from "@anchor-lang/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { MOLPHA_PROGRAM_ID, MOLPHA_SDK_PROFILE } from "../src/core/constants.js";
import { hexToBytes, utf8 } from "../src/core/encoding.js";
import type { Attestation } from "../src/core/types.js";
import { buildSubmitAttestationArgs } from "../src/solana/client.js";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/solana/kit.js";
import { feedPda, protocolConfigPda, registryPda } from "../src/solana/pdas.js";

/** Layout/instruction guards below target the parity IDL; skip under the Brebeneskul stable profile. */
const describeParityIdl = MOLPHA_SDK_PROFILE === "dev" ? describe : describe.skip;

/** Anchor discriminator: first 8 bytes of sha256("<namespace>:<name>"). */
const discriminator = (namespace: "global" | "account", name: string): number[] => [
  ...sha256(utf8(`${namespace}:${name}`)).subarray(0, 8),
];
const SUBMIT_ATTESTATION_DISCRIMINATOR = discriminator("global", "submit_attestation");
const REGISTRY_DISCRIMINATOR = discriminator("account", "Registry");
/** The discriminator the verifier crate hard-codes for the zero-copy Registry. */
const VERIFIER_REGISTRY_DISCRIMINATOR = [47, 174, 110, 246, 184, 182, 252, 218];

const COALITION_KEY = { x: new Uint8Array(32).fill(0x55), y: new Uint8Array(32).fill(0x66) };

const result: Attestation = {
  payload: {
    sourceId: "11".repeat(32),
    value: "22".repeat(32),
    timestamp: 1_700_000_000,
    registryVersion: 7,
    signaturesRequired: 3,
  },
  signature: {
    signersBitmap: "00".repeat(31) + "07",
    s: "33".repeat(32),
    commitmentAddr: "44".repeat(20),
  },
  value: "1",
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
});

describeParityIdl("vendored IDL (parity / epoch-settlement)", () => {
  it("is the epoch-settlement program IDL (no round-settlement instructions)", () => {
    const names = MOLPHA_IDL.instructions.map((ix) => ix.name);
    expect(names).toEqual(
      expect.arrayContaining(["submit_attestation", "submit_ticket", "finalize_epoch", "slash_offence"]),
    );
    for (const removed of ["settle_subscription_round", "settle_x402_round", "finalize_round", "validate_round"]) {
      expect(names).not.toContain(removed);
    }
    expect(REGISTRY_DISCRIMINATOR).toEqual(VERIFIER_REGISTRY_DISCRIMINATOR);
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
      .submitAttestation!(buildSubmitAttestationArgs(result, COALITION_KEY))
      .accountsPartial({ submitter })
      .instruction();

    expect([...ix.data.subarray(0, 8)]).toEqual(SUBMIT_ATTESTATION_DISCRIMINATOR);
    // Attestation { payload: value 32 + source_id 32 + registry_version 4 + signatures_required 1
    //   + timestamp 8, signature: agg_sig_s 32 + commitment 20 + signers_bitmap 32 },
    // raw_value: Option<bytes> = None (1), coalition_key: x 32 + y 32.
    expect(ix.data.length).toBe(8 + (32 + 32 + 4 + 1 + 8) + (32 + 20 + 32) + 1 + (32 + 32));

    // Field order inside the payload follows the program struct, not the SDK result.
    const body = ix.data.subarray(8);
    expect([...body.subarray(0, 32)]).toEqual([...hexToBytes(result.payload.value)]);
    expect([...body.subarray(32, 64)]).toEqual([...hexToBytes(result.payload.sourceId)]);
    expect(body.readUInt32LE(64)).toBe(result.payload.registryVersion);
    expect(body[68]).toBe(result.payload.signaturesRequired);
    expect(body.readBigUInt64LE(69)).toBe(BigInt(result.payload.timestamp));
    expect([...body.subarray(77, 109)]).toEqual([...hexToBytes(result.signature.s)]);
    expect([...body.subarray(109, 129)]).toEqual([...hexToBytes(result.signature.commitmentAddr)]);
    expect([...body.subarray(129, 161)]).toEqual([...hexToBytes(result.signature.signersBitmap)]);
    expect(body[161]).toBe(0); // raw_value: None
    expect([...body.subarray(162, 194)]).toEqual([...COALITION_KEY.x]);
    expect([...body.subarray(194, 226)]).toEqual([...COALITION_KEY.y]);

    const programId = MOLPHA_PROGRAM_ADDRESS;
    const expectedKeys = [
      submitter.toBase58(),
      registryPda(result.payload.registryVersion, programId),
      feedPda(hexToBytes(result.payload.sourceId), result.payload.signaturesRequired, submitter, programId),
      protocolConfigPda(programId),
      SYSTEM_PROGRAM_ADDRESS,
    ];
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(expectedKeys);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: false });
    expect(ix.keys[2]).toMatchObject({ isSigner: false, isWritable: true });
  });

  it("encodes raw_value as Some(bytes) for hashed values", async () => {
    const { program, provider } = offlineProgram();
    const rawValue = new Uint8Array(40).fill(0xab);
    const hashedResult = {
      ...result,
      payload: {
        ...result.payload,
        value: Buffer.from(keccak_256(rawValue)).toString("hex"),
      },
    };
    const ix = await program.methods
      .submitAttestation!(buildSubmitAttestationArgs(hashedResult, COALITION_KEY, rawValue))
      .accountsPartial({ submitter: provider.wallet.publicKey })
      .instruction();
    const body = ix.data.subarray(8);
    expect(body[161]).toBe(1); // Some
    expect(body.readUInt32LE(162)).toBe(40);
    expect([...body.subarray(166, 206)]).toEqual([...rawValue]);
    expect(ix.data.length).toBe(8 + 161 + 1 + 4 + 40 + 64);
  });

  it("encodes and validates submit_attestation raw_value", async () => {
    const { program, provider } = offlineProgram();
    const rawValue = new TextEncoder().encode("a value longer than the signed word");
    const hashedResult = {
      ...result,
      payload: {
        ...result.payload,
        value: Buffer.from(keccak_256(rawValue)).toString("hex"),
      },
    };
    const args = buildSubmitAttestationArgs(hashedResult, COALITION_KEY, rawValue);
    const ix = await program.methods
      .submitAttestation!(args)
      .accountsPartial({ submitter: provider.wallet.publicKey })
      .instruction();

    // Some(raw_value): option tag + u32 vector length + bytes.
    expect(ix.data.length).toBe(8 + 161 + 1 + 4 + rawValue.length + 64);
    expect(() => buildSubmitAttestationArgs(result, COALITION_KEY, rawValue)).toThrow(/digest does not match/);
    expect(() => buildSubmitAttestationArgs(hashedResult, COALITION_KEY, new Uint8Array(257))).toThrow(/256/);
  });

  it("decodes the zero-copy Registry snapshot", () => {
    const { program } = offlineProgram();
    // version 4 + node_count 2 + redundancy_buffer 1 + bump 1, nodes 256 * 32, then two i64s.
    const body = Buffer.alloc(8216);
    body.writeUInt32LE(7, 0); // version
    body.writeUInt16LE(3, 4); // node_count
    body[6] = 2; // redundancy_buffer
    body[7] = 255; // bump
    for (let i = 0; i < 3; i++) body.fill(0xa0 + i, 8 + i * 32, 8 + (i + 1) * 32);
    body.writeBigInt64LE(123_456_789n, 8200); // grace_active_until
    body.writeBigInt64LE(1_700_000_000n, 8208); // active_from

    const data = Buffer.concat([Buffer.from(REGISTRY_DISCRIMINATOR), body]);
    expect(data.length).toBe(8224);
    const registry = program.coder.accounts.decode("registry", data);
    expect(registry.version).toBe(7);
    expect(registry.nodeCount).toBe(3);
    expect(registry.redundancyBuffer).toBe(2);
    expect(registry.bump).toBe(255);
    expect(registry.nodes).toHaveLength(256);
    expect(Buffer.from(registry.nodes[2]).toString("hex")).toBe("a2".repeat(32));
    expect(Buffer.from(registry.nodes[3]).toString("hex")).toBe("00".repeat(32));
    expect(registry.graceActiveUntil.toString()).toBe("123456789");
    expect(registry.activeFrom.toString()).toBe("1700000000");
  });

  it("decodes the new Feed layout (fixed 32-byte value, kind, submitter)", () => {
    const { program } = offlineProgram();
    const submitter = web3.Keypair.generate().publicKey;
    const body = Buffer.concat([
      Buffer.alloc(32, 0x11), // source_id
      Buffer.alloc(32, 0x22), // value
      Buffer.from([1]), // value_kind = Hash
      submitter.toBuffer(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(1_700_000_123n);
        return b;
      })(),
      Buffer.from([5]), // signatures_required
      Buffer.alloc(32, 0x33), // signers_bitmap
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(9);
        return b;
      })(),
      Buffer.from([254]), // bump
    ]);
    const feed = program.coder.accounts.decode(
      "feed",
      Buffer.concat([Buffer.from(discriminator("account", "Feed")), body]),
    );
    expect(Buffer.from(feed.value).toString("hex")).toBe("22".repeat(32));
    expect(feed.valueKind).toEqual({ hash: {} });
    expect((feed.submitter as web3.PublicKey).toBase58()).toBe(submitter.toBase58());
    expect((feed.timestamp as BN).toString()).toBe("1700000123");
    expect(feed.signaturesRequired).toBe(5);
    expect(feed.registryVersion).toBe(9);
    expect(feed.bump).toBe(254);
  });

  it("has the slimmed Subscription / Delegate / Node account shapes", () => {
    const fields = (name: string) =>
      (MOLPHA_IDL.types!.find((t) => t.name === name)!.type as { fields: { name: string }[] }).fields.map(
        (f) => f.name,
      );
    expect(fields("Subscription")).toEqual([
      "owner",
      "plan_type",
      "valid_until",
      "max_rounds",
      "delegate_count",
      "max_delegates",
      "max_signers",
      "bump",
    ]);
    expect(fields("Delegate")).toEqual(["owner", "delegate", "max_data_requests", "bump"]);
    expect(fields("Node").slice(0, 3)).toEqual(["authority", "secp256k1_pubkey_x", "secp256k1_pubkey_y"]);
    expect(fields("ProtocolConfig")).toEqual(
      expect.arrayContaining(["min_signers", "epoch_len_seconds", "protocol_fee_bps"]),
    );
  });
});
