/**
 * Source secret resolution + ECDH encryption for selected nodes.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesToHex, concatBytes, hexToBytes } from "../core/encoding.js";
import { normalizeSecp256k1PublicKeyHex } from "../core/nodeKeys.js";
import { parsePrivateSource, type ParsedSource } from "../core/source.js";
import type { EncKeyBundle, Node } from "../core/types.js";

const NONCE_BYTES = 12; // AES-GCM nonce
const SYM_KEY_BYTES = 32;

// Exactly the form the nodes recognise: no whitespace, a name of letters, digits and underscores.
const SECRET_PLACEHOLDER = /\{\{secret\.([A-Za-z0-9_]+)\}\}/g;

interface EncryptionRecipient {
  index: number;
  signingKey: string;
}

/**
 * The source with its `{{secret.NAME}}` placeholders filled in: the private form that is encrypted for
 * the nodes. A placeholder is filled only where the format lets one stand and the nodes accept a
 * difference: an http input's URL, a header value and a body text. The result is validated as a source,
 * so a secret that would change where a request goes (its scheme, host or port) is refused here.
 * Throws if a referenced secret is missing.
 */
export function resolveSource(
  source: ParsedSource,
  secrets: Record<string, string>,
): ParsedSource {
  const sub = (s: string): string =>
    s.replace(SECRET_PLACEHOLDER, (_m, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(secrets, name))
        throw new Error(`Missing secret: ${name}`);
      return secrets[name]!;
    });
  const doc = structuredClone(source.doc) as { inputs: Record<string, any> };
  for (const input of Object.values(doc.inputs)) {
    if (input.kind !== "http") continue;
    const read = input.read;
    read.url = sub(read.url);
    for (const k of Object.keys(read.headers))
      read.headers[k] = sub(read.headers[k]);
    if (read.body) read.body.text = sub(read.body.text);
  }
  return parsePrivateSource(doc);
}

/**
 * Encrypt a source, with its secrets filled in, with a fresh symmetric key, then ECDH-wrap that
 * key for each selected node. The gateway only ever sees the placeholders; each node checks that what
 * it decrypts is an instance of the public source before fetching anything.
 */
export function encryptForNodes(
  source: ParsedSource,
  secrets: Record<string, string>,
  selectedNodes: Node[],
): EncKeyBundle {
  const recipients = validateEncryptionRecipients(selectedNodes);

  const plaintext = resolveSource(source, secrets).bytes;

  const symKey = randomBytes(SYM_KEY_BYTES);
  const nonceSym = randomBytes(NONCE_BYTES);
  const ciphertext = gcm(symKey, nonceSym).encrypt(plaintext);

  const ephemeralPriv = secp256k1.utils.randomSecretKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true); // compressed

  const envelopes: Record<string, string> = {};
  for (const node of recipients) {
    const envelopeIndex = String(node.index);
    const nodePub = hexToBytes(node.signingKey);
    const shared = secp256k1.getSharedSecret(ephemeralPriv, nodePub);
    const wrapKey = keccak_256(shared);
    const nonceEnv = randomBytes(NONCE_BYTES);
    const wrappedSymKey = gcm(wrapKey, nonceEnv).encrypt(symKey);
    envelopes[envelopeIndex] = bytesToHex(concatBytes(nonceEnv, wrappedSymKey));
  }

  return {
    ephemeralPub: bytesToHex(ephemeralPub),
    nonceSym: bytesToHex(nonceSym),
    ciphertext: bytesToHex(ciphertext),
    envelopes,
  };
}

function validateEncryptionRecipients(
  selectedNodes: Node[],
): EncryptionRecipient[] {
  if (selectedNodes.length === 0) throw new Error("No nodes to encrypt for");

  const envelopeIndexes = new Set<string>();
  const envelopeKeys = new Set<string>();
  return selectedNodes.map((node) => {
    if (!Number.isInteger(node.index) || node.index < 0) {
      throw new Error(
        `Selected node index must be a non-negative integer: ${node.index}`,
      );
    }
    const envelopeIndex = String(node.index);
    if (envelopeIndexes.has(envelopeIndex)) {
      throw new Error(`Duplicate selected node index: ${node.index}`);
    }
    envelopeIndexes.add(envelopeIndex);

    const signingKey = normalizeSecp256k1PublicKeyHex(
      node.signingKey,
      `Selected node ${node.index} signingKey`,
    );
    if (envelopeKeys.has(signingKey)) {
      throw new Error(`Duplicate selected node signingKey: ${node.index}`);
    }
    envelopeKeys.add(signingKey);
    return { index: node.index, signingKey };
  });
}
