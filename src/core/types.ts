/**
 * Public protocol types (spec §8). Kept dependency-free so they can be imported
 * from any entry point.
 *
 * Hex convention: every `*Id`, bitmap, scalar and address field typed `string` is plain
 * lowercase hex without a `0x` prefix unless documented otherwise.
 */

/** A registered oracle node as returned by the gateway. */
export interface Node {
  /** Position in the registry snapshot; maps to signers-bitmap bit `index`. */
  index: number;
  peerId: string;
  address: string;
  /** Node secp256k1 public key (hex). Used for ECDH config encryption. */
  signingKey: string;
}

/** Selected node-key material that must be authenticated before private API encryption. */
export interface NodeKeyVerifierArgs {
  /** 32-byte source id, hex. */
  sourceId: string;
  /** On-chain registry version the gateway round is bound to. */
  registryVersion: number;
  /** Canonical timestamp used to derive the selected indexes. */
  timestamp: number;
  /** Selected node indexes derived from the round bitmap, ascending. */
  selectedIndexes: readonly number[];
  /** Gateway-provided selected nodes whose keys must be authenticated. */
  selectedNodes: readonly Node[];
}

/**
 * Authenticates selected gateway node encryption keys. Throwing fails the
 * private API request before secrets are encrypted or posted.
 */
export type NodeKeyVerifier = (args: NodeKeyVerifierArgs) => void | Promise<void>;

/** The off-chain API definition a source resolves. */
export interface APIConfig {
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  /** Expression that extracts the value from the HTTP response. */
  responseParser: string;
  /** Optional expression applied to the parsed value before packing. */
  valueTransform?: string;
}

/** ECDH-wrapped API config payload sent to selected nodes. */
export interface EncKeyBundle {
  ephemeralPub: string;
  nonceSym: string;
  ciphertext: string;
  /** nodeIndex -> hex(nonceEnv || wrappedSymKey) */
  envelopes: Record<string, string>;
}

/** Signs a 32-byte message and returns a 64-byte ed25519 signature. */
export type Signer = (message: Uint8Array) => Promise<Uint8Array>;

/**
 * On-chain registry fields a gateway selection round is bound to. `registryVersion`
 * comes from `RegistryState.current_version`; `redundancyBuffer` and `nodeCount` from
 * the version-addressed `Registry` snapshot.
 */
export interface RegistrySelectionConfig {
  registryVersion: number;
  /** Selection padding: `min(signaturesRequired + redundancyBuffer, nodeCount)`. */
  redundancyBuffer: number;
  /**
   * `Registry.node_count` of the snapshot — the value the chain derives selection from.
   * Optional for standalone callers; when absent the gateway node-list length is used.
   */
  nodeCount?: number;
}

/**
 * Aggregate Schnorr signature in the commitment-address form the program verifies over
 * the attestation message (see `attestationMessageHash`).
 */
export interface SchnorrSignature {
  /** 32-byte scalar, hex. */
  s: string;
  /** 20-byte EVM-style commitment address, hex. */
  commitmentAddr: string;
  /** 32-byte big-endian signers bitmap, hex. */
  signersBitmap: string;
}

/** A completed gateway round, ready to submit on-chain. */
export interface DataUpdateResult {
  /** 32-byte source id, hex (`deriveSourceId(apiConfig)`). */
  sourceId: string;
  /** Human-readable value. */
  value: string;
  /** 32-byte packed value, hex — the bytes covered by the signature. */
  valuePacked: string;
  /** canonicalTimestamp (seconds). */
  timestamp: number;
  registryVersion: number;
  signaturesRequired: number;
  /** 32-byte big-endian bitmap, hex. */
  signersBitmap: string;
  /** 32-byte scalar, hex. */
  s: string;
  /** 20-byte commitment address, hex. */
  commitmentAddr: string;
  /** Whether the value was freshly fetched this round. */
  fresh: boolean;
}
