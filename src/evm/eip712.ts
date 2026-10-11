/**
 * EIP-712 typed-data hashing and EIP-3009 `TransferWithAuthorization` digests.
 *
 * Used to sign payments to an API source that is itself x402-paywalled: the
 * caller authorizes a transfer from their own wallet, so the token contract is
 * the EIP-712 verifying contract. Signature-critical bytes — must stay
 * byte-identical with the token contract and the source's facilitator.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, bytesToHex0x, concatBytes, hexToBytes, utf8 } from "../core/encoding.js";
import type { EvmSigner } from "../core/types.js";

/** EIP-712 domain of the token contract that will settle the authorization. */
export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  /** Token contract address, 0x-prefixed. */
  verifyingContract: string;
}

/** EIP-3009 transfer authorization. Amounts are decimal strings of base units. */
export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 0x-prefixed 32-byte nonce. */
  nonce: string;
}

const typeHash = (signature: string): Uint8Array => keccak_256(utf8(signature));

export const EIP712_DOMAIN_TYPEHASH = typeHash(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
);

export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = typeHash(
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
);

/** ABI-encode one 32-byte word from raw bytes, right-aligned. */
function word(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new RangeError("ABI word overflow");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function addressWord(address: string): Uint8Array {
  const bytes = hexToBytes(address);
  if (bytes.length !== 20) throw new RangeError(`Not a 20-byte address: ${address}`);
  return word(bytes);
}

function uintWord(value: string | bigint): Uint8Array {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new RangeError(`Not an unsigned integer: ${value}`);
  const hex = n.toString(16);
  return word(hexToBytes(hex.length % 2 === 0 ? hex : "0" + hex));
}

function bytes32Word(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) throw new RangeError(`Not a 32-byte value: ${value}`);
  return bytes;
}

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  return keccak_256(
    concatBytes(
      EIP712_DOMAIN_TYPEHASH,
      keccak_256(utf8(domain.name)),
      keccak_256(utf8(domain.version)),
      uintWord(BigInt(domain.chainId)),
      addressWord(domain.verifyingContract),
    ),
  );
}

export function transferWithAuthorizationHash(auth: TransferAuthorization): Uint8Array {
  return keccak_256(
    concatBytes(
      TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
      addressWord(auth.from),
      addressWord(auth.to),
      uintWord(auth.value),
      uintWord(auth.validAfter),
      uintWord(auth.validBefore),
      bytes32Word(auth.nonce),
    ),
  );
}

/** The 32-byte digest a wallet signs: `keccak256(0x1901 || domain || struct)`. */
export function transferWithAuthorizationDigest(
  domain: Eip712Domain,
  auth: TransferAuthorization,
): Uint8Array {
  return keccak_256(
    concatBytes(
      Uint8Array.from([0x19, 0x01]),
      domainSeparator(domain),
      transferWithAuthorizationHash(auth),
    ),
  );
}

/** EIP-55 checksum form. Some facilitators reject non-checksummed addresses. */
export function toChecksumAddress(address: string): string {
  const lower = bytesToHex(hexToBytes(address));
  if (lower.length !== 40) throw new RangeError(`Not a 20-byte address: ${address}`);
  const digest = bytesToHex(keccak_256(utf8(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(digest[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}

/** The EIP-55 address of a raw secp256k1 private key. */
export function evmAddressFromPrivateKey(privateKey: string | Uint8Array): string {
  const key = typeof privateKey === "string" ? hexToBytes(privateKey) : privateKey;
  if (key.length !== 32) throw new RangeError("EVM private key must be 32 bytes");
  const uncompressed = secp256k1.getPublicKey(key, false);
  // Drop the 0x04 tag, keccak the 64-byte point, keep the low 20 bytes.
  return toChecksumAddress(bytesToHex0x(keccak_256(uncompressed.subarray(1)).subarray(12)));
}

/**
 * Build an {@link EvmSigner} from a raw secp256k1 private key. The key stays in
 * the caller's process: neither Molpha nor the gateway ever sees one.
 */
export function createEvmSignerFromPrivateKey(privateKey: string | Uint8Array): EvmSigner {
  const key = typeof privateKey === "string" ? hexToBytes(privateKey) : privateKey;
  const address = evmAddressFromPrivateKey(key);

  return {
    address,
    async signDigest(digest: Uint8Array): Promise<Uint8Array> {
      if (digest.length !== 32) throw new RangeError("Digest must be 32 bytes");
      // Noble returns [recovery || r || s]; Ethereum wants r || s || v.
      const signed = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
      const out = new Uint8Array(65);
      out.set(signed.subarray(1), 0);
      out[64] = 27 + signed[0]!;
      return out;
    },
  };
}
