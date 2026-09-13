/**
 * Starknet verifier helpers — framework-agnostic builders for
 * `verify(attestation: Attestation, max_age: u64) -> (bool, u8)` on deployed Molpha
 * verifier contracts, plus a raw calldata encoder and a result decoder.
 *
 * Nothing here depends on `starknet.js`. The struct objects use the Cairo member names, so
 * an ABI-aware client can pass them straight through; `encodeStarknetVerifyCalldata`
 * produces the flat felt array for a raw `starknet_call`.
 */
import { bigIntFromBytesBe, toFixedBytes } from "../core/encoding.js";
import type { DataUpdateResult } from "../core/types.js";
import { VERIFY_CODES, verifyCodeName, type VerifyCodeName } from "../core/verifyCodes.js";

/**
 * Starknet calldata shape for `AttestationPayload`.
 *
 * Member order is the order of the signed message preimage and of Cairo `Serde`, so it is
 * load bearing — it is not the order of `DataUpdateResult`.
 */
export interface StarknetAttestationPayload {
  /** 32-byte packed value as `u256`. */
  value: bigint;
  /** 32-byte source id as `u256`. */
  source_id: bigint;
  /** `u32`. */
  registry_version: number;
  /** `u8`. */
  signatures_required: number;
  /** `u64`, unix seconds. */
  canonical_timestamp: number;
}

/** Starknet calldata shape for `SchnorrSignature`. */
export interface StarknetSchnorrSignature {
  /** Schnorr scalar `s` as `u256`. */
  signature: bigint;
  /** Ethereum-style 20-byte address of the nonce point `R`, as a `felt252`. */
  commitment: bigint;
  /** Big-endian signers bitmap as `u256`; bit `i` is node `i` of the registry version. */
  signers_bitmap: bigint;
}

/** Starknet calldata shape for `Attestation`. */
export interface StarknetAttestation {
  payload: StarknetAttestationPayload;
  signature: StarknetSchnorrSignature;
}

/** Positional arguments for `verify(attestation, max_age)`. */
export interface StarknetVerifierArgs {
  attestation: StarknetAttestation;
  /** Freshness window in seconds (`u64`). `0` disables the check. */
  maxAge: number;
}

export interface BuildStarknetVerifierArgsOptions {
  /**
   * Freshness window in seconds. The verifier rejects the attestation with `STALE` when it
   * is older than this, and as `MALFORMED` when it is dated in the future.
   *
   * Required on purpose. `0` disables the check entirely, and that is not a neutral
   * default: the verifier is stateless, so without a window it accepts a correctly signed
   * attestation forever. Pass `0` only when the consuming contract enforces freshness or
   * ordering itself.
   */
  maxAge: number;
}

/** Decoded `verify` return value. */
export interface StarknetVerifyResult {
  success: boolean;
  /** Raw result code — see `VERIFY_CODES`. */
  code: number;
  /** Name of `code`, or `"UNKNOWN"` for a code newer than this SDK. */
  reason: VerifyCodeName | "UNKNOWN";
}

/** A felt as returned by `starknet_call` (hex or decimal string) or by an ABI-aware client. */
export type StarknetFeltLike = string | number | bigint | boolean;

const U8_MAX = 0xffn;
const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const U128_MASK = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const ADDRESS_MAX = (1n << 160n) - 1n;

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

function toStrictHex(value: string, bytes: number, label: string): `0x${string}` {
  const clean = strip0x(stripOuterQuotes(value)).toLowerCase();
  if (clean.length !== bytes * 2) {
    throw new RangeError(
      `${label}: expected ${bytes} bytes (${bytes * 2} hex chars), got ${clean.length / 2}`,
    );
  }
  return `0x${clean}`;
}

function fixedHexToBigInt(value: string, bytes: number, label: string): bigint {
  const hex = toStrictHex(value, bytes, label);
  const raw = toFixedBytes(hex, bytes, label);
  return bigIntFromBytesBe(raw);
}

/**
 * Checks an integer fits its Cairo type. Out-of-range calldata does not reach `verify` at
 * all: Cairo `Serde` fails while decoding the arguments, and the call reverts instead of
 * returning a result code. Catching it here keeps that failure in the caller's process.
 */
function assertUint(value: number, max: bigint, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > max) {
    throw new RangeError(`${label}: expected an integer in 0..${max}, got ${value}`);
  }
  return value;
}

function assertBigUint(value: bigint, max: bigint, label: string): bigint {
  if (value < 0n || value > max) {
    throw new RangeError(`${label}: expected an integer in 0..${max}, got ${value}`);
  }
  return value;
}

function toFelt(value: bigint | number): `0x${string}` {
  return `0x${BigInt(value).toString(16)}`;
}

/** Cairo `u256` serializes as two felts, low limb first. */
function u256Felts(value: bigint, label: string): [`0x${string}`, `0x${string}`] {
  assertBigUint(value, U256_MAX, label);
  return [toFelt(value & U128_MASK), toFelt(value >> 128n)];
}

function feltToBigInt(value: StarknetFeltLike, label: string): bigint {
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${label}: not an integer: ${value}`);
    return BigInt(value);
  }
  const text = value.trim();
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) {
    throw new RangeError(`${label}: not a felt: ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

/** Convert a 20-byte commitment address hex to a Starknet felt-compatible bigint. */
export function commitmentAddressToStarknetFelt(value: string): bigint {
  return fixedHexToBigInt(value, 20, "commitment");
}

/** Convert a 32-byte bitmap hex to a Starknet/Cairo `u256` bigint. */
export function signersBitmapToStarknetUint256(value: string): bigint {
  return fixedHexToBigInt(value, 32, "signersBitmap");
}

/**
 * Build the `verify(attestation, max_age)` arguments from a gateway result.
 *
 * ```ts
 * const { attestation, maxAge } = buildStarknetVerifierArgs(result, { maxAge: 300 });
 * ```
 */
export function buildStarknetVerifierArgs(
  result: DataUpdateResult,
  options: BuildStarknetVerifierArgsOptions,
): StarknetVerifierArgs {
  const payload: StarknetAttestationPayload = {
    value: fixedHexToBigInt(result.valuePacked, 32, "valuePacked"),
    source_id: fixedHexToBigInt(result.sourceId, 32, "sourceId"),
    registry_version: assertUint(result.registryVersion, U32_MAX, "registryVersion"),
    signatures_required: assertUint(result.signaturesRequired, U8_MAX, "signaturesRequired"),
    canonical_timestamp: assertUint(result.timestamp, U64_MAX, "timestamp"),
  };

  const signature: StarknetSchnorrSignature = {
    signature: fixedHexToBigInt(result.s, 32, "signature"),
    commitment: commitmentAddressToStarknetFelt(result.commitmentAddr),
    signers_bitmap: signersBitmapToStarknetUint256(result.signersBitmap),
  };

  return {
    attestation: { payload, signature },
    maxAge: assertUint(options.maxAge, U64_MAX, "maxAge"),
  };
}

/**
 * Flat felt calldata for `verify(attestation, max_age)`, in Cairo `Serde` order — 13 felts:
 *
 * `value.low, value.high, source_id.low, source_id.high, registry_version,
 *  signatures_required, canonical_timestamp, signature.low, signature.high, commitment,
 *  signers_bitmap.low, signers_bitmap.high, max_age`
 *
 * For a raw `starknet_call` with `entry_point_selector = selector("verify")`.
 */
export function encodeStarknetVerifyCalldata(args: StarknetVerifierArgs): `0x${string}`[] {
  const { payload, signature } = args.attestation;
  return [
    ...u256Felts(payload.value, "value"),
    ...u256Felts(payload.source_id, "source_id"),
    toFelt(assertUint(payload.registry_version, U32_MAX, "registry_version")),
    toFelt(assertUint(payload.signatures_required, U8_MAX, "signatures_required")),
    toFelt(assertUint(payload.canonical_timestamp, U64_MAX, "canonical_timestamp")),
    ...u256Felts(signature.signature, "signature"),
    // An Ethereum-style address, so it must fit 160 bits (the verifier reports a wider one
    // as `MALFORMED`; one past the field prime would not even deserialize).
    toFelt(assertBigUint(signature.commitment, ADDRESS_MAX, "commitment")),
    ...u256Felts(signature.signers_bitmap, "signers_bitmap"),
    toFelt(assertUint(args.maxAge, U64_MAX, "maxAge")),
  ];
}

/**
 * Decode the `(bool, u8)` returned by `verify`.
 *
 * Accepts the raw two-felt array from `starknet_call` (e.g. `["0x1", "0x0"]`) or the tuple
 * an ABI-aware client decodes (e.g. `{ 0: true, 1: 0n }`). Throws when the two halves
 * disagree (`success` with a non-zero code, or failure with `OK`), which means the call did
 * not reach a Molpha verifier of this interface.
 */
export function parseStarknetVerifyResult(
  result:
    | readonly StarknetFeltLike[]
    | { readonly 0: StarknetFeltLike; readonly 1: StarknetFeltLike },
): StarknetVerifyResult {
  if (Array.isArray(result) && result.length !== 2) {
    throw new RangeError(`verify result: expected 2 felts, got ${result.length}`);
  }
  const tuple = result as { readonly 0: StarknetFeltLike; readonly 1: StarknetFeltLike };

  const successFelt = feltToBigInt(tuple[0], "verify result success");
  if (successFelt !== 0n && successFelt !== 1n) {
    throw new RangeError(`verify result: success must be 0 or 1, got ${successFelt}`);
  }
  const codeFelt = feltToBigInt(tuple[1], "verify result code");
  if (codeFelt < 0n || codeFelt > U8_MAX) {
    throw new RangeError(`verify result: code must fit u8, got ${codeFelt}`);
  }

  const success = successFelt === 1n;
  const code = Number(codeFelt);
  if (success !== (code === VERIFY_CODES.OK)) {
    throw new Error(
      `verify result is inconsistent: success=${success} with code ${code}; ` +
        "the call did not reach a Molpha verifier with this interface",
    );
  }

  return { success, code, reason: verifyCodeName(code) ?? "UNKNOWN" };
}
