/**
 * EVM verifier argument helpers — framework-agnostic tuple builders for
 * `verify(DataUpdate, SchnorrSignature)` on deployed Molpha verifier contracts.
 */
import { bigIntFromBytesBe, toFixedBytes } from "../core/encoding.js";
import type { DataUpdateResult } from "../core/types.js";

/** `(bytes32 sourceId, uint32 registryVersion, uint32 signaturesRequired, bytes32 valuePacked, uint64 timestamp)` */
export type EvmDataUpdateTuple = readonly [
  sourceId: `0x${string}`,
  registryVersion: number,
  signaturesRequired: number,
  valuePacked: `0x${string}`,
  timestamp: number,
];

/** `(bytes32 s, address commitment, uint256 signersBitmap)` */
export type EvmSchnorrSignatureTuple = readonly [
  s: `0x${string}`,
  commitment: `0x${string}`,
  signersBitmap: bigint,
];

export interface EvmVerifierArgs {
  dataUpdate: EvmDataUpdateTuple;
  signature: EvmSchnorrSignatureTuple;
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

/** Build verifier `DataUpdate` and `SchnorrSignature` tuples from a gateway result. */
export function buildEvmVerifierArgs(result: DataUpdateResult): EvmVerifierArgs {
  const dataUpdate: EvmDataUpdateTuple = [
    toFixedHex(result.sourceId, 32, "sourceId"),
    result.registryVersion,
    result.signaturesRequired,
    toFixedHex(result.valuePacked, 32, "valuePacked"),
    result.timestamp,
  ];

  const signature: EvmSchnorrSignatureTuple = [
    toFixedHex(result.s, 32, "signature"),
    toFixedHex(result.commitmentAddr, 20, "commitment"),
    signersBitmapToUint256(result.signersBitmap),
  ];

  return { dataUpdate, signature };
}

/** Decimal string form of the signers bitmap — useful for JSON logging or legacy tooling. */
export function signersBitmapToDecimal(value: string): string {
  return signersBitmapToUint256(value).toString();
}
