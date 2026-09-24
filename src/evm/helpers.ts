/**
 * EVM verifier helpers — framework-agnostic builders for
 * `verify(Attestation attestation, uint64 maxAge) returns (bool success, uint8 code)` on
 * deployed Molpha verifier contracts, plus a raw calldata encoder and a result decoder.
 *
 * Nothing here depends on ethers or viem. The struct objects use the Solidity member names
 * and viem's primitive types (`uint64`/`uint256` as `bigint`, `uint32`/`uint8` as `number`),
 * so they pass straight into `readContract` with `MOLPHA_VERIFIER_ABI` or into an ethers
 * `Contract`; `encodeEvmVerifyCalldata` produces the bytes for a raw `eth_call`.
 */
import {
  bigIntFromBytesBe,
  bytesToHex,
  concatBytes,
  hexToBytes,
  toFixedBytes,
  u256beFromBigInt,
} from "../core/encoding.js";
import type { DataUpdateResult } from "../core/types.js";
import { VERIFY_CODES, verifyCodeName, type VerifyCodeName } from "../core/verifyCodes.js";

/**
 * `IVerifier.AttestationPayload` — the signed half of an attestation.
 *
 * Member order is the order of the signed message preimage and of the ABI tuple, so it is
 * load bearing — it is not the order of `DataUpdateResult`.
 */
export interface EvmAttestationPayload {
  /** `bytes32` packed value. */
  value: `0x${string}`;
  /** `bytes32` source id. */
  sourceId: `0x${string}`;
  /** `uint32`. */
  registryVersion: number;
  /** `uint8`. */
  signaturesRequired: number;
  /** `uint64`, unix seconds. */
  canonicalTimestamp: bigint;
}

/** `IVerifier.SchnorrSignature`. */
export interface EvmSchnorrSignature {
  /** `bytes32` Schnorr scalar `s`. */
  signature: `0x${string}`;
  /** `address` of the nonce point `R`. */
  commitment: `0x${string}`;
  /** `uint256` signers bitmap; bit `i` is node `i` of the registry version. */
  signersBitmap: bigint;
}

/** `IVerifier.Attestation`. */
export interface EvmAttestation {
  payload: EvmAttestationPayload;
  signature: EvmSchnorrSignature;
}

/** Positional arguments for `verify(attestation, maxAge)`. */
export interface EvmVerifierArgs {
  attestation: EvmAttestation;
  /** Freshness window in seconds (`uint64`). `0n` disables the check. */
  maxAge: bigint;
}

export interface BuildEvmVerifierArgsOptions {
  /**
   * Freshness window in seconds. The verifier rejects the attestation with `STALE` when it
   * is older than this, and as `MALFORMED` when it is dated in the future.
   *
   * Required on purpose. `0` disables the check entirely, and that is not a neutral
   * default: the verifier is stateless, so without a window it accepts a correctly signed
   * attestation forever. Pass `0` only when the consuming contract enforces freshness or
   * ordering itself.
   */
  maxAge: number | bigint;
}

/** Decoded `verify` return value. */
export interface EvmVerifyResult {
  success: boolean;
  /** Raw result code — see `VERIFY_CODES`. */
  code: number;
  /** Name of `code`, or `"UNKNOWN"` for a code newer than this SDK. */
  reason: VerifyCodeName | "UNKNOWN";
}

/**
 * `bytes4(keccak256("verify(((bytes32,bytes32,uint32,uint8,uint64),(bytes32,address,uint256)),uint64)"))`.
 */
const VERIFY_SELECTOR = hexToBytes("67e2907b");

const U8_MAX = 0xffn;
const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const U256_MAX = (1n << 256n) - 1n;

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Normalize hex to a fixed-size `0x`-prefixed value.
 * Accepts optional `0x` prefix and surrounding quotes.
 */
export function toFixedHex(value: string, bytes: number, label: string): `0x${string}` {
  const clean = strip0x(stripOuterQuotes(value)).toLowerCase();
  if (clean.length !== bytes * 2) {
    throw new RangeError(
      `${label}: expected ${bytes} bytes (${bytes * 2} hex chars), got ${clean.length / 2}`,
    );
  }
  return `0x${clean}`;
}

/** Convert a 32-byte hex bitmap to a `uint256` bigint (big-endian). */
export function signersBitmapToUint256(value: string): bigint {
  const bytes = toFixedBytes(toFixedHex(value, 32, "signersBitmap"), 32, "signersBitmap");
  return bigIntFromBytesBe(bytes);
}

/** Decimal string form of the signers bitmap — useful for JSON logging or legacy tooling. */
export function signersBitmapToDecimal(value: string): string {
  return signersBitmapToUint256(value).toString();
}

/**
 * Checks an integer fits its Solidity type. Out-of-range calldata does not reach `verify`
 * at all: the ABI decoder reverts on dirty high bits instead of returning a result code.
 * Catching it here keeps that failure in the caller's process.
 */
function assertUint(value: number, max: bigint, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > max) {
    throw new RangeError(`${label}: expected an integer in 0..${max}, got ${value}`);
  }
  return value;
}

function assertBigUint(value: number | bigint, max: bigint, label: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${label}: expected an integer in 0..${max}, got ${value}`);
  }
  const n = BigInt(value);
  if (n < 0n || n > max) {
    throw new RangeError(`${label}: expected an integer in 0..${max}, got ${value}`);
  }
  return n;
}

/** Left-pad a fixed-width value into one 32-byte ABI word. */
function word(value: string, bytes: number, label: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(toFixedBytes(toFixedHex(value, bytes, label), bytes, label), 32 - bytes);
  return out;
}

/**
 * Build the `verify(attestation, maxAge)` arguments from a gateway result.
 *
 * ```ts
 * const { attestation, maxAge } = buildEvmVerifierArgs(result, { maxAge: 300 });
 * await client.readContract({ abi: MOLPHA_VERIFIER_ABI, functionName: "verify", args: [attestation, maxAge], ... });
 * ```
 */
export function buildEvmVerifierArgs(
  result: DataUpdateResult,
  options: BuildEvmVerifierArgsOptions,
): EvmVerifierArgs {
  const payload: EvmAttestationPayload = {
    value: toFixedHex(result.valuePacked, 32, "valuePacked"),
    sourceId: toFixedHex(result.sourceId, 32, "sourceId"),
    registryVersion: assertUint(result.registryVersion, U32_MAX, "registryVersion"),
    signaturesRequired: assertUint(result.signaturesRequired, U8_MAX, "signaturesRequired"),
    canonicalTimestamp: assertBigUint(result.timestamp, U64_MAX, "timestamp"),
  };

  const signature: EvmSchnorrSignature = {
    signature: toFixedHex(result.s, 32, "signature"),
    commitment: toFixedHex(result.commitmentAddr, 20, "commitment"),
    signersBitmap: signersBitmapToUint256(result.signersBitmap),
  };

  return {
    attestation: { payload, signature },
    maxAge: assertBigUint(options.maxAge, U64_MAX, "maxAge"),
  };
}

/**
 * ABI calldata for `verify(attestation, maxAge)`: the 4-byte selector followed by nine
 * 32-byte words. Both structs are static, so they encode inline with no offsets:
 *
 * `value, sourceId, registryVersion, signaturesRequired, canonicalTimestamp, signature,
 *  commitment, signersBitmap, maxAge`
 *
 * For a raw `eth_call` (`{ to: verifier, data }`).
 */
export function encodeEvmVerifyCalldata(args: EvmVerifierArgs): `0x${string}` {
  const { payload, signature } = args.attestation;
  const data = concatBytes(
    VERIFY_SELECTOR,
    word(payload.value, 32, "value"),
    word(payload.sourceId, 32, "sourceId"),
    u256beFromBigInt(BigInt(assertUint(payload.registryVersion, U32_MAX, "registryVersion"))),
    u256beFromBigInt(
      BigInt(assertUint(payload.signaturesRequired, U8_MAX, "signaturesRequired")),
    ),
    u256beFromBigInt(assertBigUint(payload.canonicalTimestamp, U64_MAX, "canonicalTimestamp")),
    word(signature.signature, 32, "signature"),
    word(signature.commitment, 20, "commitment"),
    u256beFromBigInt(assertBigUint(signature.signersBitmap, U256_MAX, "signersBitmap")),
    u256beFromBigInt(assertBigUint(args.maxAge, U64_MAX, "maxAge")),
  );
  return `0x${bytesToHex(data)}`;
}

/**
 * Decode the `(bool, uint8)` returned by `verify`.
 *
 * Accepts the raw 64-byte return data from `eth_call`, or the tuple an ABI-aware client
 * decodes (viem `readContract` returns `[true, 0]`; an ethers `Result` indexes the same way).
 * Throws when the two halves disagree (`success` with a non-zero code, or failure with
 * `OK`), which means the call did not reach a Molpha verifier of this interface.
 */
export function parseEvmVerifyResult(
  result:
    | string
    | { readonly 0: boolean | number | bigint; readonly 1: number | bigint },
): EvmVerifyResult {
  let successWord: bigint;
  let codeWord: bigint;

  if (typeof result === "string") {
    const clean = strip0x(result.trim());
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length !== 128) {
      throw new RangeError(
        `verify result: expected 64 bytes of return data, got ${JSON.stringify(result)}`,
      );
    }
    successWord = BigInt(`0x${clean.slice(0, 64)}`);
    codeWord = BigInt(`0x${clean.slice(64)}`);
  } else {
    const success = result[0];
    const code = result[1];
    successWord = typeof success === "boolean" ? (success ? 1n : 0n) : BigInt(success);
    if (typeof code === "number" && !Number.isSafeInteger(code)) {
      throw new RangeError(`verify result: code must fit uint8, got ${code}`);
    }
    codeWord = BigInt(code);
  }

  if (successWord !== 0n && successWord !== 1n) {
    throw new RangeError(`verify result: success must be 0 or 1, got ${successWord}`);
  }
  if (codeWord < 0n || codeWord > U8_MAX) {
    throw new RangeError(`verify result: code must fit uint8, got ${codeWord}`);
  }

  const success = successWord === 1n;
  const code = Number(codeWord);
  if (success !== (code === VERIFY_CODES.OK)) {
    throw new Error(
      `verify result is inconsistent: success=${success} with code ${code}; ` +
        "the call did not reach a Molpha verifier with this interface",
    );
  }

  return { success, code, reason: verifyCodeName(code) ?? "UNKNOWN" };
}
