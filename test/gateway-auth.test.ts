import { web3 } from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { MOLPHA_PROGRAM_ID } from "../src/core/constants.js";
import { concatBytes, u64le, utf8 } from "../src/core/encoding.js";
import {
  REQUEST_AUTH_DOMAIN,
  encodeRequestAuth,
  hashRequestAuth,
} from "../src/gateway/auth.js";
import {
  addressToBytes,
  deriveGatewayPda,
  deriveGatewayPdaAddress,
  normalizeEndpoint,
  parseGatewayInfo,
} from "../src/gateway/identity.js";
import { MOLPHA_IDL } from "../idl/index.js";
import { gatewayPda } from "../src/solana/pdas.js";

const AUTHORITY = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";
const programId = addressToBytes(MOLPHA_PROGRAM_ID);
const gateway = new Uint8Array(32).fill(0x42);
const sourceId = Uint8Array.from({ length: 32 }, (_, i) => i);
const timestamp = 1_750_000_000;
const fields = { programId, gateway, sourceId, signaturesRequired: 3, timestamp };

describe("hashRequestAuth", () => {
  it("is keccak256(MOLPHA_REQAUTH_V1 || borsh(RequestAuth))", () => {
    expect(REQUEST_AUTH_DOMAIN).toEqual(utf8("MOLPHA_REQAUTH_V1"));
    // borsh(RequestAuth { program_id, gateway, source_id, signatures_required: u8, timestamp: u64 })
    const body = concatBytes(programId, gateway, sourceId, Uint8Array.of(3), u64le(timestamp));
    expect(body).toHaveLength(32 + 32 + 32 + 1 + 8);
    expect(encodeRequestAuth(fields)).toEqual(body);
    expect(hashRequestAuth(fields)).toEqual(
      keccak_256(concatBytes(utf8("MOLPHA_REQAUTH_V1"), body)),
    );
    expect(hashRequestAuth(fields)).toHaveLength(32);
  });

  it("binds every field", () => {
    const base = hashRequestAuth(fields);
    expect(hashRequestAuth({ ...fields, programId: new Uint8Array(32).fill(1) })).not.toEqual(base);
    expect(hashRequestAuth({ ...fields, gateway: new Uint8Array(32).fill(1) })).not.toEqual(base);
    expect(hashRequestAuth({ ...fields, sourceId: new Uint8Array(32).fill(1) })).not.toEqual(base);
    expect(hashRequestAuth({ ...fields, signaturesRequired: 4 })).not.toEqual(base);
    expect(hashRequestAuth({ ...fields, timestamp: timestamp + 1 })).not.toEqual(base);
  });

  it("accepts a hex sourceId and a bigint timestamp", () => {
    const hex = Buffer.from(sourceId).toString("hex");
    expect(hashRequestAuth({ ...fields, sourceId: hex, timestamp: BigInt(timestamp) })).toEqual(
      hashRequestAuth(fields),
    );
    expect(hashRequestAuth({ ...fields, sourceId: `0x${hex}` })).toEqual(hashRequestAuth(fields));
  });

  it("rejects out-of-range or malformed inputs", () => {
    expect(() => hashRequestAuth({ ...fields, signaturesRequired: 0 })).toThrow(/u8/);
    expect(() => hashRequestAuth({ ...fields, signaturesRequired: 256 })).toThrow(/u8/);
    expect(() => hashRequestAuth({ ...fields, programId: new Uint8Array(31) })).toThrow();
    expect(() => hashRequestAuth({ ...fields, gateway: new Uint8Array(33) })).toThrow();
    expect(() => hashRequestAuth({ ...fields, sourceId: "aa" })).toThrow();
    expect(() => hashRequestAuth({ ...fields, timestamp: -1 })).toThrow();
  });

  it("produces a message an ed25519 consumer key can sign", () => {
    const msg = hashRequestAuth(fields);
    const secret = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(secret);
    const signature = ed25519.sign(msg, secret);
    expect(ed25519.verify(signature, msg, publicKey)).toBe(true);
  });
});

describe("gateway identity", () => {
  it("derives the same Gateway PDA via @solana/kit and web3.js", async () => {
    const kitPda = await deriveGatewayPdaAddress(AUTHORITY, MOLPHA_PROGRAM_ID);
    expect(kitPda).toBe(gatewayPda(AUTHORITY, MOLPHA_PROGRAM_ID));

    const [expected] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("molpha_gateway"), new web3.PublicKey(AUTHORITY).toBuffer()],
      new web3.PublicKey(MOLPHA_PROGRAM_ID),
    );
    expect(kitPda).toBe(expected.toBase58());
    expect(await deriveGatewayPda(AUTHORITY, MOLPHA_PROGRAM_ID)).toEqual(expected.toBytes());
  });

  it("MOLPHA_PROGRAM_ID matches the vendored IDL address", () => {
    expect(MOLPHA_PROGRAM_ID).toBe(MOLPHA_IDL.address);
  });

  it("normalizes endpoint inputs", () => {
    expect(normalizeEndpoint("http://gw/")).toEqual({ url: "http://gw" });
    expect(normalizeEndpoint({ url: "http://gw/", gatewayAuthority: AUTHORITY })).toEqual({
      url: "http://gw",
      gatewayAuthority: AUTHORITY,
    });
    expect(() => normalizeEndpoint("")).toThrow();
  });

  it("parses /v1/info payloads", () => {
    expect(parseGatewayInfo({ gatewayAuthority: AUTHORITY })).toEqual({ gatewayAuthority: AUTHORITY });
    expect(parseGatewayInfo({ gatewayAuthority: AUTHORITY, programId: MOLPHA_PROGRAM_ID })).toEqual({
      gatewayAuthority: AUTHORITY,
      programId: MOLPHA_PROGRAM_ID,
    });
    expect(() => parseGatewayInfo({})).toThrow(/gatewayAuthority/);
    expect(() => parseGatewayInfo(null)).toThrow(/malformed/);
    expect(() => parseGatewayInfo({ gatewayAuthority: AUTHORITY, programId: 7 })).toThrow(/programId/);
  });
});
