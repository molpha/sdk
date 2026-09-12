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

/**
 * Registry selection policy as advertised by the gateway's `GET /v1/nodes`.
 *
 * Advisory only — the authoritative values come from the on-chain registry read
 * ({@link RegistrySelectionConfig}). Useful to gateway-only callers with no Solana
 * connection, who otherwise cannot size a paid source's eligible set.
 */
export interface RegistryInfo {
  /** `RegistryState.current_version`. */
  version: number;
  nodeCount: number;
  redundancyBuffer: number;
}

/** `GET /v1/nodes` payload: the peer set plus the advisory registry policy. */
export interface NodesInfo {
  nodes: Node[];
  /** Absent when the gateway could not read the chain. */
  registry?: RegistryInfo;
}

/** EIP-712 domain fields of the token contract that settles a source payment. */
export interface AssetDomain {
  name: string;
  version: string;
}

/**
 * Signs a 32-byte EIP-712 digest, returning a 65-byte `r || s || v` signature.
 * Private keys never leave the caller's process.
 */
export interface EvmSigner {
  /** 0x-prefixed 20-byte address that funds the authorizations. */
  address: string;
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/** A paywalled API source's own payment terms, read from its HTTP 402. */
export interface UpstreamTerms {
  x402Version: 1 | 2;
  /** The source's `accepts` entry, echoed verbatim in the signed payload. */
  requirements: Record<string, unknown>;
  /** The source's network id, as it wrote it (CAIP-2 or an x402 v1 name). */
  network: string;
  chainId: number;
  /** Token contract, 0x-prefixed — the EIP-712 verifying contract. */
  asset: string;
  payTo: string;
  /** Price per source call, in token base units. */
  amount: string;
  maxTimeoutSeconds: number;
  domain: AssetDomain;
  /** The source URL these terms were read from. */
  resource: string;
}

/**
 * The gateway's relayed quote for a paywalled source, from `extensions.upstream`
 * of a 402 response. It carries no payment terms of its own: the price, recipient
 * and network come from the source's own 402, which the caller reads directly.
 */
export interface UpstreamQuote {
  resource: string;
  signaturesRequired: number;
  redundancyBuffer: number;
  nodeCount: number;
  /** Source fetches this round may perform, and so authorizations to sign. */
  eligibleSetSize: number;
  supportedX402Versions: number[];
  /** The source's own rejection detail, when a round hit the paywall the hard way. */
  error?: string;
}

/** Pays an API source that is itself x402-paywalled. */
export interface SourcePaymentOptions {
  /** Wallet that funds the source calls (see `createEvmSignerFromPrivateKey`). */
  signer: EvmSigner;
  /** Terms to use instead of probing the source for its 402. */
  terms?: UpstreamTerms;
  /** EIP-712 domain override for sources that omit `extra.name` / `extra.version`. */
  assetDomain?: AssetDomain;
}
