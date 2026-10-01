import { describe, expect, it } from "vitest";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { deriveSourceId } from "../src/core/apiconfig.js";
import { bytesToHex, hexToBytes, utf8 } from "../src/core/encoding.js";
import {
  normalizeSecp256k1PublicKeyHex,
  secp256k1PublicKeyFromCoordinates,
} from "../src/core/nodeKeys.js";
import type { Node } from "../src/core/types.js";
import { encryptForNodes, resolveAPIConfig } from "../src/gateway/encryption.js";

describe("resolveAPIConfig", () => {
  it("substitutes {{secret.*}} placeholders in string fields", () => {
    const resolved = resolveAPIConfig(
      {
        url: "https://api/{{secret.path}}",
        headers: { Authorization: "Bearer {{secret.token}}" },
        responseParser: "$.price",
      },
      { path: "v1/price", token: "abc123" },
    );
    expect(resolved.url).toBe("https://api/v1/price");
    expect(resolved.headers?.Authorization).toBe("Bearer abc123");
  });

  it("throws on a missing secret", () => {
    expect(() =>
      resolveAPIConfig({ url: "{{secret.missing}}", responseParser: "x" }, {}),
    ).toThrow(/Missing secret/);
  });
});

describe("encryptForNodes", () => {
  it("produces one envelope per selected node", () => {
    const node: Node = {
      index: 3,
      peerId: "p",
      address: "a",
      signingKey: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
    };
    const bundle = encryptForNodes(
      { url: "https://api", responseParser: "$.price" },
      {},
      [node],
    );
    expect(Object.keys(bundle.envelopes)).toEqual(["3"]);
    expect(bundle.ephemeralPub.length).toBeGreaterThan(0);
    expect(bundle.ciphertext.length).toBeGreaterThan(0);
  });

  it("rejects duplicate selected node indexes before resolving secrets", () => {
    const signingKey = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
    );
    const duplicateIndexNodes: Node[] = [
      { index: 3, peerId: "p1", address: "a1", signingKey },
      {
        index: 3,
        peerId: "p2",
        address: "a2",
        signingKey: bytesToHex(
          secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
        ),
      },
    ];

    expect(() =>
      encryptForNodes(
        { url: "{{secret.missing}}", responseParser: "$.price" },
        {},
        duplicateIndexNodes,
      ),
    ).toThrow(/Duplicate selected node index/);
  });

  it("rejects duplicate selected node public keys", () => {
    const signingKey = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
    );
    const duplicateKeyNodes: Node[] = [
      { index: 3, peerId: "p1", address: "a1", signingKey },
      { index: 4, peerId: "p2", address: "a2", signingKey },
    ];

    expect(() =>
      encryptForNodes(
        { url: "https://api", responseParser: "$.price" },
        {},
        duplicateKeyNodes,
      ),
    ).toThrow(/Duplicate selected node signingKey/);
  });
});

describe("secp256k1 node key helpers", () => {
  it("normalizes compressed and uncompressed public keys to the same compressed hex", () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    const compressed = bytesToHex(secp256k1.getPublicKey(privateKey, true));
    const uncompressed = bytesToHex(secp256k1.getPublicKey(privateKey, false));

    expect(normalizeSecp256k1PublicKeyHex(uncompressed)).toBe(compressed);
    expect(normalizeSecp256k1PublicKeyHex(compressed)).toBe(compressed);
  });

  it("reconstructs and validates a public key from registry X/Y coordinates", () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    const compressed = bytesToHex(secp256k1.getPublicKey(privateKey, true));
    const uncompressed = secp256k1.getPublicKey(privateKey, false);

    expect(
      secp256k1PublicKeyFromCoordinates(
        hexToBytes(bytesToHex(uncompressed.slice(1, 33))),
        hexToBytes(bytesToHex(uncompressed.slice(33, 65))),
      ),
    ).toBe(compressed);
  });

  it("rejects invalid public keys", () => {
    expect(() => normalizeSecp256k1PublicKeyHex("02".padEnd(66, "0"))).toThrow(
      /invalid secp256k1 public key/,
    );
  });
});

describe("encryptForNodes with aggregation (tolerance mode)", () => {
  const aggregation = {
    mode: "tolerance" as const,
    rule: "median" as const,
    maxDeviationBps: 50,
    maxAgeMs: 2000,
    numeric: { type: "int256" as const, decimals: 8 },
  };

  /** Node-side decrypt, mirroring `new/codec/private_api.go` `decryptAPIConfig`. */
  function decrypt(
    bundle: ReturnType<typeof encryptForNodes>,
    index: number,
    secret: Uint8Array,
  ): string {
    const shared = secp256k1.getSharedSecret(secret, hexToBytes(bundle.ephemeralPub), true);
    const wrapKey = keccak_256(shared);
    const envelope = hexToBytes(bundle.envelopes[String(index)]!);
    const symKey = gcm(wrapKey, envelope.slice(0, 12)).decrypt(envelope.slice(12));
    const plaintext = gcm(symKey, hexToBytes(bundle.nonceSym)).decrypt(hexToBytes(bundle.ciphertext));
    return new TextDecoder().decode(plaintext);
  }

  function nodeWithKey(index: number) {
    const secret = secp256k1.utils.randomSecretKey();
    const node: Node = {
      index,
      peerId: `p${index}`,
      address: `a${index}`,
      signingKey: bytesToHex(secp256k1.getPublicKey(secret, true)),
    };
    return { node, secret };
  }

  it("keeps aggregation through secret resolution (and never substitutes inside it)", () => {
    const resolved = resolveAPIConfig(
      {
        url: "https://api/{{secret.path}}",
        responseParser: "$.price",
        aggregation,
      },
      { path: "v1" },
    );
    expect(resolved.url).toBe("https://api/v1");
    expect(resolved.aggregation).toEqual(aggregation);
  });

  it("encrypts the canonical JSON, byte-identical to the sourceId preimage when no secrets are used", () => {
    const { node, secret } = nodeWithKey(2);
    const config = { url: "https://api", responseParser: "$.price", aggregation };
    const bundle = encryptForNodes(config, {}, [node]);
    const plaintext = decrypt(bundle, 2, secret);

    expect(plaintext).toBe(
      '{"url":"https://api","method":"GET","headers":{},"responseParser":"$.price","valueTransform":"",' +
        '"aggregation":{"mode":"tolerance","rule":"median","maxDeviationBps":50,"maxAgeMs":2000,"numeric":{"type":"int256","decimals":8}}}',
    );
    expect(keccak_256(utf8(plaintext))).toEqual(deriveSourceId(config));
  });

  it("with secrets, only the placeholder fields differ from the hashed config", () => {
    const { node, secret } = nodeWithKey(0);
    const config = {
      url: "https://api/{{secret.path}}",
      responseParser: "$.price",
      aggregation,
    };
    const plaintext = JSON.parse(decrypt(encryptForNodes(config, { path: "v1" }, [node]), 0, secret));
    expect(plaintext.url).toBe("https://api/v1");
    expect(plaintext.aggregation).toEqual(aggregation);
    expect(Object.keys(plaintext)).toEqual([
      "url",
      "method",
      "headers",
      "responseParser",
      "valueTransform",
      "aggregation",
    ]);
  });

  it("rejects an invalid aggregation before encrypting", () => {
    const { node } = nodeWithKey(0);
    expect(() =>
      encryptForNodes(
        { url: "https://api", responseParser: "$", aggregation: { ...aggregation, mode: "exact" } as never },
        {},
        [node],
      ),
    ).toThrow(/mode "exact"/);
  });
});
