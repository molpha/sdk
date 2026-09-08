/**
 * Starknet verifier argument helpers — framework-agnostic struct builders for
 * `verify(DataUpdate, SchnorrSignature)` on deployed Molpha verifier contracts.
 */
import { bigIntFromBytesBe, toFixedBytes } from "../core/encoding.js";
import type { DataUpdateResult } from "../core/types.js";

/** Starknet calldata shape for `DataUpdate`. */
export interface StarknetDataUpdate {
  /** 32-byte source id as u256 (the Cairo struct still names this field `feed_id`). */
  source_id: bigint;
  registry_version: number;
  signatures_required: number;
  value: bigint;
  canonical_timestamp: number;
}

/** Starknet calldata shape for `SchnorrSignature`. */
export interface StarknetSchnorrSignature {
  signature: bigint;
  commitment: bigint;
  signers_bitmap: bigint;
}

export interface StarknetVerifierArgs {
  dataUpdate: StarknetDataUpdate;
  signature: StarknetSchnorrSignature;
}

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

/** Convert a 20-byte EVM-style address hex to a Starknet felt-compatible bigint. */
export function commitmentAddressToStarknetFelt(value: string): bigint {
  return fixedHexToBigInt(value, 20, "commitment");
}

/** Convert a 32-byte bitmap hex to a Starknet/Cairo `u256` bigint. */
export function signersBitmapToStarknetUint256(value: string): bigint {
  return fixedHexToBigInt(value, 32, "signersBitmap");
}

/** Build verifier `DataUpdate` and `SchnorrSignature` structs from a gateway result. */
export function buildStarknetVerifierArgs(result: DataUpdateResult): StarknetVerifierArgs {
  const dataUpdate: StarknetDataUpdate = {
    source_id: fixedHexToBigInt(result.sourceId, 32, "sourceId"),
    registry_version: result.registryVersion,
    signatures_required: result.signaturesRequired,
    value: fixedHexToBigInt(result.valuePacked, 32, "valuePacked"),
    canonical_timestamp: result.timestamp,
  };

  const signature: StarknetSchnorrSignature = {
    signature: fixedHexToBigInt(result.s, 32, "signature"),
    commitment: commitmentAddressToStarknetFelt(result.commitmentAddr),
    signers_bitmap: signersBitmapToStarknetUint256(result.signersBitmap),
  };

  return { dataUpdate, signature };
}
