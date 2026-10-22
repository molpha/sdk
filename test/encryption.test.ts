import { describe, expect, it } from "vitest";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { jsonPriceSource } from "../src/core/sourcebuild.js";
import { bytesToHex, hexToBytes, utf8 } from "../src/core/encoding.js";
import {
  normalizeSecp256k1PublicKeyHex,
  secp256k1PublicKeyFromCoordinates,
} from "../src/core/nodeKeys.js";
import type { Node } from "../src/core/types.js";
import { encryptForNodes, resolveSource } from "../src/gateway/encryption.js";

const publicSource = (url: string, headers?: Record<string, string>, tolerance = false) =>
  jsonPriceSource({
    url, path: "$.price", decimals: 8, ...(headers ? { headers } : {}),
    ...(tolerance ? { tolerance: { maxDeviationBps: 50, maxAgeMs: 2000 } } : {}),
  });

describe("resolveSource", () => {
  it("substitutes {{secret.*}} placeholders in a URL and header values", () => {
    const resolved = resolveSource(
      publicSource("https://api/{{secret.path}}", { authorization: "Bearer {{secret.token}}" }),
      { path: "v1/price", token: "abc123" },
    );
    const read = (resolved.doc.inputs as Record<string, any>).px.read;
    expect(read.url).toBe("https://api/v1/price");
    expect(read.headers.authorization).toBe("Bearer abc123");
  });

  it("throws on a missing secret", () => {
    expect(() => resolveSource(publicSource("https://api/{{secret.missing}}"), {})).toThrow(/Missing secret/);
  });

  it("leaves everything but the placeholders alone, including the aggregation", () => {
    const pub = publicSource("https://api/{{secret.path}}", undefined, true);
    const resolved = resolveSource(pub, { path: "v1" });
    expect((resolved.doc.aggregation as object)).toEqual((pub.doc.aggregation as object));
    expect(resolved.output).toEqual(pub.output);
  });

  it("refuses a secret that would move the request to another host", () => {
    // A placeholder cannot be in the host at all; and what fills one in the path cannot leave it.
    expect(() => publicSource("https://{{secret.h}}.example/p")).toThrow(/host and port must be literal/);
    expect(() => resolveSource(publicSource("https://api/{{secret.p}}"), { p: "a#b" })).toThrow(/fragment/);
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
    const bundle = encryptForNodes(publicSource("https://api"), {}, [node]);
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
      encryptForNodes(publicSource("https://api/{{secret.missing}}"), {}, duplicateIndexNodes),
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
      encryptForNodes(publicSource("https://api"), {}, duplicateKeyNodes),
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

describe("encryptForNodes with a tolerance source", () => {
  /** Node-side decrypt, mirroring `new/codec/private_api.go` `decryptSource`. */
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

  it("encrypts the canonical bytes, byte-identical to the sourceId preimage when no secrets are used", () => {
    const { node, secret } = nodeWithKey(2);
    const source = publicSource("https://api", undefined, true);
    const plaintext = decrypt(encryptForNodes(source, {}, [node]), 2, secret);

    expect(plaintext).toBe(source.canonical);
    expect(bytesToHex(keccak_256(utf8(plaintext)))).toBe(source.idHex.slice(2));
  });

  it("with secrets, only the placeholder fields differ from the hashed source", () => {
    const { node, secret } = nodeWithKey(0);
    const source = publicSource("https://api/{{secret.path}}", undefined, true);
    const plaintext = JSON.parse(decrypt(encryptForNodes(source, { path: "v1" }, [node]), 0, secret));
    const pub = JSON.parse(source.canonical);
    expect(plaintext.inputs.px.read.url).toBe("https://api/v1");
    // Everything but that one string is the public source.
    plaintext.inputs.px.read.url = pub.inputs.px.read.url;
    expect(plaintext).toEqual(pub);
  });
});
