import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, bytesToHex0x } from "../src/core/encoding.js";
import {
  EIP712_DOMAIN_TYPEHASH,
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
  createEvmSignerFromPrivateKey,
  domainSeparator,
  evmAddressFromPrivateKey,
  toChecksumAddress,
  transferWithAuthorizationDigest,
} from "../src/evm/eip712.js";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("EIP-712 / EIP-3009 primitives", () => {
  it("matches the published type hashes", () => {
    // EIP-712 §Specification and EIP-3009.
    expect(bytesToHex0x(EIP712_DOMAIN_TYPEHASH)).toBe(
      "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
    );
    expect(bytesToHex0x(TRANSFER_WITH_AUTHORIZATION_TYPEHASH)).toBe(
      "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
    );
  });

  it("reproduces the EIP-712 worked example domain separator", () => {
    expect(
      bytesToHex0x(
        domainSeparator({
          name: "Ether Mail",
          version: "1",
          chainId: 1,
          verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
        }),
      ),
    ).toBe("0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f");
  });

  it("checksums addresses per EIP-55", () => {
    expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );
    // Idempotent, and accepts an already-checksummed input.
    expect(toChecksumAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );
  });

  it("rejects values that are not the size their ABI slot requires", () => {
    const auth = {
      from: "0x" + "11".repeat(20),
      to: "0x" + "22".repeat(20),
      value: "1",
      validAfter: "0",
      validBefore: "1",
      nonce: "0x" + "33".repeat(32),
    };
    const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC };
    expect(() =>
      transferWithAuthorizationDigest(domain, { ...auth, to: "0x1234" }),
    ).toThrow(/20-byte address/);
    expect(() =>
      transferWithAuthorizationDigest(domain, { ...auth, nonce: "0x" + "33".repeat(16) }),
    ).toThrow(/32-byte value/);
    expect(() =>
      transferWithAuthorizationDigest(domain, { ...auth, value: "-1" }),
    ).toThrow(/unsigned integer/);
  });
});

describe("createEvmSignerFromPrivateKey", () => {
  const key = new Uint8Array(32);
  key[31] = 1;

  it("derives the well-known address for private key 1", () => {
    expect(evmAddressFromPrivateKey(key)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(createEvmSignerFromPrivateKey("0x" + "00".repeat(31) + "01").address).toBe(
      "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    );
  });

  it("produces a 65-byte r || s || v signature that recovers the signer", async () => {
    const signer = createEvmSignerFromPrivateKey(key);
    const digest = transferWithAuthorizationDigest(
      { name: "USDC", version: "2", chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC },
      {
        from: signer.address,
        to: "0x1111111111111111111111111111111111111111",
        value: "10000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "11".repeat(32),
      },
    );

    const signature = await signer.signDigest(digest);
    expect(signature.length).toBe(65);
    const v = signature[64]!;
    expect([27, 28]).toContain(v);

    // Ethereum layout is r || s || v; noble puts the recovery byte first.
    const noble = new Uint8Array(65);
    noble[0] = v - 27;
    noble.set(signature.subarray(0, 64), 1);
    const recovered = secp256k1.recoverPublicKey(noble, digest, { prehash: false });
    expect(bytesToHex(recovered)).toBe(bytesToHex(secp256k1.getPublicKey(key, true)));
  });

  it("rejects a key or digest of the wrong length", async () => {
    expect(() => createEvmSignerFromPrivateKey(new Uint8Array(31))).toThrow(/32 bytes/);
    await expect(
      createEvmSignerFromPrivateKey(key).signDigest(new Uint8Array(31)),
    ).rejects.toThrow(/32 bytes/);
  });
});
