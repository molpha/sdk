/**
 * `MolphaGateway` — isomorphic HTTP client with multi-endpoint failover.
 */
import { canonicalizeAPIConfig, deriveSourceId } from "../core/apiconfig.js";
import { MOLPHA_PROGRAM_ID } from "../core/constants.js";
import { bytesToHex, bytesToHex0x } from "../core/encoding.js";
import { normalizeSecp256k1PublicKeyHex } from "../core/nodeKeys.js";
import {
  deriveGroupBitmap,
  deriveSelectionSeed,
  effectiveSelectionSize,
  selectedIndices,
} from "../core/selection.js";
import type {
  APIConfig,
  DataUpdateResult,
  Node,
  NodeKeyVerifier,
  NodesInfo,
  RegistrySelectionConfig,
  Signer,
  SourcePaymentOptions,
  UpstreamTerms,
} from "../core/types.js";
import { hashRequestAuth } from "./auth.js";
import { encryptForNodes } from "./encryption.js";
import {
  UpstreamPaymentRequiredError,
  parseUpstreamQuote,
  probeSource,
  signSourcePayments,
} from "./x402.js";
import {
  addressToBytes,
  deriveGatewayPda,
  normalizeEndpoint,
  parseGatewayInfo,
  type GatewayEndpoint,
  type GatewayEndpointInput,
  type GatewayInfo,
} from "./identity.js";

export type { RegistrySelectionConfig } from "../core/types.js";
export * from "./auth.js";
export * from "./identity.js";
export * from "./x402.js";

export interface RequestSignedDataOptions {
  /**
   * The API definition to resolve. Its canonical form determines the round's
   * `sourceId = keccak256(JSON.stringify(canonicalizeAPIConfig(apiConfig)))`, so pass the
   * same config (including `{{secret.*}}` placeholders) every time.
   */
  apiConfig: APIConfig;
  /** Requested quorum (u8, ≥ the protocol `min_signers`). */
  signaturesRequired: number;
  /**
   * Solana pubkey (base58) of the subscription owner.
   * Overrides the gateway's `defaultSubscriptionOwner` when set.
   */
  subscriptionOwner?: string;
  /**
   * Solana pubkey (base58) of the consumer authority that signs gateway auth.
   * Overrides the gateway's `defaultConsumerAuthority` when set.
   */
  consumerAuthority?: string;
  /**
   * Signs `hashRequestAuth({ programId, gateway, sourceId, signaturesRequired, timestamp })`.
   * The hash binds the gateway's on-chain account, so it is computed — and the signer
   * invoked — once per endpoint actually tried. Overrides the gateway's `defaultSigner`
   * when set. When both are omitted, sends an all-zero authSig (dev only).
   */
  signer?: Signer;
  encrypt?: { secrets: Record<string, string> };
  /**
   * Pays an API source that is itself x402-paywalled. The SDK reads the source's
   * own 402, signs one authorization per node in the round's eligible set, and
   * sends them with the round as `sourcePayments`.
   *
   * Payment goes to the source, never to Molpha: the round still costs exactly
   * one round of subscription quota. Only authorizations a node actually spends
   * ever settle, so the redundancy buffer costs nothing when it goes unused.
   * Without this, a paywalled source throws {@link UpstreamPaymentRequiredError}.
   */
  sourcePayment?: SourcePaymentOptions;
  /** Max accepted value age in seconds. Default 60. */
  maxAge?: number;
  /** Each retry re-rolls the timestamp. Default 15. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Pre-fetched round inputs. Any field present here skips its network/on-chain
   * fetch, so a fully-populated context turns `requestSignedData` into a single
   * POST round (the "short" flow). Build a reusable one with
   * {@link MolphaGateway.prepareContext}.
   *
   * Caching is opt-in because these inputs can drift: a stale `registryVersion`,
   * `redundancyBuffer`, `nodeCount`, or `nodes` set produces a result the chain will
   * reject. Refresh the context when the on-chain registry version changes.
   */
  context?: Partial<RoundContext>;
  /**
   * Authenticates selected gateway node encryption keys before private API
   * secrets are encrypted. Overrides the gateway-level verifier when set.
   */
  verifyNodeKeys?: NodeKeyVerifier;
  /**
   * Unsafe development escape hatch for standalone gateway usage. When true,
   * encrypted private API requests may use gateway-provided node keys without
   * authentication. Defaults to false.
   */
  allowUnverifiedNodeKeysForPrivateApi?: boolean;
}

export interface MolphaGatewayOptions {
  /** Solana pubkey (base58) of the subscription owner used when a request omits it. */
  defaultSubscriptionOwner?: string;
  /** Solana pubkey (base58) of the consumer authority used when a request omits it. */
  defaultConsumerAuthority?: string;
  /**
   * Molpha program id the request authorization is bound to. Defaults to the vendored
   * `MOLPHA_PROGRAM_ID`; must match the gateway's deployment.
   */
  programId?: string;
  /**
   * Authenticates selected gateway node encryption keys before private API
   * secrets are encrypted.
   */
  verifyNodeKeys?: NodeKeyVerifier;
  /**
   * Unsafe development escape hatch. When true, encrypted private API requests
   * may use gateway-provided node keys without authentication. Defaults to false.
   */
  allowUnverifiedNodeKeysForPrivateApi?: boolean;
}

/**
 * The slow-changing inputs a `requestSignedData` round binds to. Fetch once with
 * {@link MolphaGateway.prepareContext} and reuse across many rounds.
 */
export interface RoundContext extends RegistrySelectionConfig {
  /** Full node set used to encrypt private API secrets for the selected nodes. */
  nodes: Node[];
}

/** Round inputs after resolution; `nodes` is only fetched when a round needs it. */
interface ResolvedRound extends RegistrySelectionConfig {
  nodes?: Node[];
}

interface GatewaySignedDataResponse {
  status: "completed" | "pending" | string;
  data?: GatewaySignedData;
}

interface GatewaySignedData {
  sourceId?: string;
  value?: string;
  valuePacked?: string;
  timestamp?: number;
  registryVersion?: number;
  signaturesRequired?: number;
  signersBitmap?: string;
  s?: string;
  commitmentAddr?: string;
  fresh?: boolean;
}

interface GatewayEnvelope<T> {
  status: string;
  data: T;
}

const ZERO_AUTH_SIG = new Uint8Array(64);

/** Default gateway base URL when `endpoints` is omitted. */
export const DEFAULT_GATEWAY_ENDPOINT = "https://dev-gateway.molpha.io/";

/** Thrown for terminal gateway errors (400/401) — never retried. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export class MolphaGateway {
  private readonly endpoints: GatewayEndpoint[];
  private readonly getRegistrySelectionConfig: () => Promise<RegistrySelectionConfig>;
  private readonly defaultSigner?: Signer;
  private readonly defaultSubscriptionOwner?: string;
  private readonly defaultConsumerAuthority?: string;
  private readonly verifyNodeKeys?: NodeKeyVerifier;
  private readonly allowUnverifiedNodeKeysForPrivateApi: boolean;
  /** Program id the request authorization is bound to (base58). */
  readonly programId: string;
  private readonly programIdBytes: Uint8Array;
  /** Gateway PDA per endpoint URL; resolved once per client lifetime. */
  private readonly gatewayPdas = new Map<string, Promise<Uint8Array>>();

  constructor(
    endpoints?: GatewayEndpointInput | GatewayEndpointInput[],
    getRegistrySelectionConfig: () => Promise<RegistrySelectionConfig> = async () => {
      throw new Error(
        "MolphaGateway requires getRegistrySelectionConfig to request signed data — pass the current on-chain registry version, redundancy buffer and node count (e.g. () => solana.getRegistrySelectionConfig())",
      );
    },
    defaultSigner?: Signer,
    /**
     * Either a default subscription owner (base58) or gateway options. A string
     * keeps the previous positional form used by standalone callers/tests.
     */
    defaultSubscriptionOwnerOrOptions?: string | MolphaGatewayOptions,
    defaultConsumerAuthority?: string,
  ) {
    const list =
      endpoints === undefined
        ? [DEFAULT_GATEWAY_ENDPOINT]
        : Array.isArray(endpoints)
          ? endpoints
          : [endpoints];
    if (list.length === 0) throw new Error("At least one endpoint is required");
    this.endpoints = list.map(normalizeEndpoint);
    this.getRegistrySelectionConfig = getRegistrySelectionConfig;
    this.defaultSigner = defaultSigner;

    const options: MolphaGatewayOptions =
      typeof defaultSubscriptionOwnerOrOptions === "string"
        ? {
            defaultSubscriptionOwner: defaultSubscriptionOwnerOrOptions,
            defaultConsumerAuthority,
          }
        : (defaultSubscriptionOwnerOrOptions ?? {});

    this.defaultSubscriptionOwner = options.defaultSubscriptionOwner;
    this.defaultConsumerAuthority =
      options.defaultConsumerAuthority ?? options.defaultSubscriptionOwner;
    this.verifyNodeKeys = options.verifyNodeKeys;
    this.allowUnverifiedNodeKeysForPrivateApi =
      options.allowUnverifiedNodeKeysForPrivateApi ?? false;
    this.programId = options.programId ?? MOLPHA_PROGRAM_ID;
    this.programIdBytes = addressToBytes(this.programId);
  }

  /** Tries endpoints in order; returns the first node list it can fetch. */
  async getNodes(): Promise<Node[]> {
    return (await this.getNodesInfo()).nodes;
  }

  /**
   * `GET /v1/nodes` — the peer set plus the gateway's view of the registry
   * selection policy, which sizes the eligible set a paid source must fund.
   *
   * The `registry` block is advisory: it is whatever the gateway read from the
   * chain, and is absent on older gateways or when that read failed. Prefer the
   * on-chain read (`MolphaSolanaClient.getRegistrySelectionConfig`) whenever a
   * Solana connection is available — `requestSignedData` already does.
   */
  async getNodesInfo(): Promise<NodesInfo> {
    const data = await this.firstReachableData<NodesInfo | Node[]>("/v1/nodes");
    if (Array.isArray(data)) return { nodes: data };
    return {
      nodes: data.nodes,
      ...(data.registry ? { registry: data.registry } : {}),
    };
  }

  async isHealthy(): Promise<boolean> {
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint.url}/health`, { method: "GET" });
        if (res.ok) return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  /**
   * `GET {url}/v1/info` — the gateway's on-chain identity. Throws when the gateway
   * reports a `programId` different from this client's.
   */
  async fetchGatewayInfo(
    endpoint: GatewayEndpointInput,
    timeoutMs?: number,
  ): Promise<GatewayInfo> {
    const { url } = normalizeEndpoint(endpoint);
    const res = await this.fetchWithTimeout(`${url}/v1/info`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      throw new GatewayError(`GET /v1/info failed (${res.status})`, res.status);
    }
    const info = parseGatewayInfo(unwrapEnvelope(await res.json(), "/v1/info"));
    if (info.programId !== undefined && info.programId !== this.programId) {
      throw new GatewayError(
        `Gateway ${url} settles against program ${info.programId}, but this client is bound to ${this.programId}`,
      );
    }
    return info;
  }

  /**
   * Fetch the slow-changing round inputs (registry version, redundancy buffer,
   * node count, node set) once so they can be reused across many
   * {@link requestSignedData} calls. Pass the result back via
   * `requestSignedData({ ..., context })` to skip the prelude and run a
   * single-round "short" flow.
   *
   * Both fetches run in parallel. Registry version, redundancy buffer and node
   * count come from the on-chain registry read.
   */
  async prepareContext(): Promise<RoundContext> {
    const [registry, nodes] = await Promise.all([
      this.getRegistrySelectionConfig(),
      this.getNodes(),
    ]);
    return { ...registry, nodes };
  }

  /**
   * Request a threshold-signed data update from the gateway, with retry +
   * failover. Per attempt a fresh timestamp yields a fresh selection bitmap; the
   * body is POSTed to each endpoint in order until one `completed`s.
   *
   * The round's `sourceId` is derived from `apiConfig`. The request authorization
   * binds the program id and each gateway's on-chain account, so the auth signature
   * is recomputed for every endpoint tried.
   *
   * By default this fetches the registry selection config up front and the node
   * set only when the round needs it (private API encryption, or when the registry
   * read does not report `nodeCount`). Supply `opts.context` (e.g. from
   * {@link prepareContext}) to reuse cached inputs and skip those fetches — a
   * fully-populated context collapses the call to a single POST round.
   *
   * When the API source is itself x402-paywalled, pass `opts.sourcePayment` to
   * fund it; without that, such a source throws
   * {@link UpstreamPaymentRequiredError} carrying the gateway's quote.
   */
  async requestSignedData(opts: RequestSignedDataOptions): Promise<DataUpdateResult> {
    const {
      apiConfig,
      signer,
      encrypt,
      sourcePayment,
      maxAge = 60,
      maxRetries = 15,
      timeoutMs = 5000,
    } = opts;
    const signaturesRequired = assertSignaturesRequired(opts.signaturesRequired);

    const verifyNodeKeys = opts.verifyNodeKeys ?? this.verifyNodeKeys;
    const allowUnverified =
      opts.allowUnverifiedNodeKeysForPrivateApi ??
      this.allowUnverifiedNodeKeysForPrivateApi;
    if (encrypt && !verifyNodeKeys && !allowUnverified) {
      throw new Error(
        "Private API encryption requires authenticated node keys. Provide verifyNodeKeys or set allowUnverifiedNodeKeysForPrivateApi: true for unsafe development use.",
      );
    }

    const requestApiConfig = canonicalizeAPIConfig(apiConfig);
    const sourceIdBytes = deriveSourceId(requestApiConfig);
    const sourceId = bytesToHex(sourceIdBytes);

    const subscriptionOwner = opts.subscriptionOwner ?? this.defaultSubscriptionOwner;
    if (!subscriptionOwner) {
      throw new Error(
        "subscriptionOwner is required — pass opts.subscriptionOwner or set MolphaGateway defaultSubscriptionOwner (MolphaSDK sets this from wallet.publicKey)",
      );
    }
    const consumerAuthority =
      opts.consumerAuthority ?? this.defaultConsumerAuthority ?? subscriptionOwner;
    const authSigner = signer ?? this.defaultSigner;

    const round = await this.resolveContext(opts.context, encrypt !== undefined);
    const { registryVersion, redundancyBuffer } = round;
    if (
      round.nodeCount !== undefined &&
      round.nodes !== undefined &&
      round.nodes.length !== round.nodeCount
    ) {
      throw new Error(
        `Gateway node list has ${round.nodes.length} nodes but registry ${registryVersion} has node_count ${round.nodeCount} — refresh the round context`,
      );
    }
    const nodeCount = round.nodeCount ?? round.nodes?.length;
    if (nodeCount === undefined) {
      throw new Error("Round context resolved neither nodeCount nor nodes");
    }

    // A paywalled source is paid by the caller, per node fetch, from their own
    // wallet. Read the source's terms once, then sign fresh authorizations per
    // attempt so a retry never reuses a nonce. The registry already tells us the
    // eligible set size, so no quote round trip is needed in the common case.
    let terms: UpstreamTerms | null = null;
    let authorizations = 0;
    let requoted = false;
    if (sourcePayment) {
      terms =
        sourcePayment.terms ??
        (await probeSource(apiConfig, {
          ...(encrypt ? { secrets: encrypt.secrets } : {}),
          ...(sourcePayment.assetDomain ? { assetDomain: sourcePayment.assetDomain } : {}),
          timeoutMs,
        }));
      if (terms) {
        authorizations = effectiveSelectionSize(
          signaturesRequired,
          redundancyBuffer,
          nodeCount,
        );
      }
    }

    let lastError: unknown;
    // Each attempt must be its own round: the tuple that identifies a round
    // includes the timestamp, and a dispatched round cannot be re-dispatched.
    let lastTimestamp = 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let timestamp = Math.floor(Date.now() / 1000);
      if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1;
      lastTimestamp = timestamp;

      const seed = deriveSelectionSeed(sourceIdBytes, registryVersion, timestamp);
      const groupSize = effectiveSelectionSize(signaturesRequired, redundancyBuffer, nodeCount);
      const bitmap = deriveGroupBitmap(seed, nodeCount, groupSize);
      const indices = selectedIndices(bitmap, nodeCount);

      let encKeyBundle: ReturnType<typeof encryptForNodes> | undefined;
      if (encrypt) {
        const selected = selectedNodesForPrivateApiEncryption(round.nodes ?? [], indices);

        if (verifyNodeKeys) {
          await verifyNodeKeys({
            sourceId,
            registryVersion,
            timestamp,
            selectedIndexes: [...indices],
            selectedNodes: selected.map((node) => ({ ...node })),
          });
        }

        encKeyBundle = encryptForNodes(requestApiConfig, encrypt.secrets, selected);
      }

      // Fresh authorizations per attempt: each carries a unique nonce, which is
      // what keeps one from settling twice.
      let sourcePayments: string[] | undefined;
      if (terms && sourcePayment && authorizations > 0) {
        sourcePayments = await signSourcePayments(
          terms,
          sourcePayment.signer,
          authorizations,
        );
      }

      const baseBody: Record<string, unknown> = {
        sourceId,
        registryVersion,
        timestamp,
        maxAge,
        signaturesRequired,
        subscriptionOwner,
        consumerAuthority,
        apiConfig: requestApiConfig,
      };
      if (encKeyBundle) baseBody.encKeyBundle = encKeyBundle;
      if (sourcePayments) baseBody.sourcePayments = sourcePayments;

      /** Set when a relayed source quote makes this attempt's round obsolete. */
      let requote = false;
      for (const endpoint of this.endpoints) {
        try {
          let authSig: Uint8Array = ZERO_AUTH_SIG;
          if (authSigner) {
            const gateway = await this.resolveGatewayPda(endpoint, timeoutMs);
            authSig = await authSigner(
              hashRequestAuth({
                programId: this.programIdBytes,
                gateway,
                sourceId: sourceIdBytes,
                signaturesRequired,
                timestamp,
              }),
            );
          }
          const body = { ...baseBody, authSig: bytesToHex0x(authSig) };

          const res = await this.post(
            `${endpoint.url}/v1/round/execute`,
            body,
            timeoutMs,
          );

          // The API source itself wants paying, so the gateway relays its quote
          // instead of a fetch failure. Payment is required, just not to Molpha.
          if (res.status === 402) {
            const quote = parseUpstreamQuote(
              await res.json().catch(() => null),
            );
            if (!quote) {
              throw new GatewayError(
                "Gateway requires payment but returned no upstream source quote",
                402,
              );
            }
            if (!sourcePayment) throw new UpstreamPaymentRequiredError(quote);
            // Already funded to the quoted size and still refused: the source
            // rejected the payment material, which resigning cannot fix.
            if (terms && requoted && authorizations >= quote.eligibleSetSize) {
              throw new UpstreamPaymentRequiredError(
                quote,
                `Source payment was not accepted for ${quote.resource}: ${quote.error ?? "no detail"}`,
              );
            }
            requoted = true;
            authorizations = quote.eligibleSetSize;
            if (!terms) {
              // Terms we cannot sign are terminal, not transient: surface them
              // with the quote instead of re-probing once per attempt.
              try {
                terms = await probeSource(apiConfig, {
                  ...(encrypt ? { secrets: encrypt.secrets } : {}),
                  ...(sourcePayment.assetDomain
                    ? { assetDomain: sourcePayment.assetDomain }
                    : {}),
                  timeoutMs,
                });
              } catch (err) {
                throw new UpstreamPaymentRequiredError(
                  quote,
                  `Cannot pay ${quote.resource}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            if (!terms) {
              throw new UpstreamPaymentRequiredError(
                quote,
                `Gateway reports ${quote.resource} is paywalled but the source returned no payment terms`,
              );
            }
            // Recover on a fresh timestamp: this round is spent, so the next
            // attempt is a new round rather than a retry of the failed one.
            lastError = new UpstreamPaymentRequiredError(quote);
            requote = true;
            break;
          }

          const errorDetail = !res.ok ? await parseGatewayErrorDetail(res) : undefined;
          if (res.status === 400 || res.status === 401) {
            throw new GatewayError(
              formatGatewayErrorMessage("Gateway rejected request", res.status, errorDetail),
              res.status,
            );
          }
          if (res.status === 503) {
            lastError = new GatewayError(
              formatGatewayErrorMessage("Gateway unavailable", 503, errorDetail),
              503,
            );
            continue; // a different gateway may already hold the AggSig
          }
          if (!res.ok) {
            lastError = new GatewayError(
              formatGatewayErrorMessage("Gateway error", res.status, errorDetail),
              res.status,
            );
            continue;
          }
          const json = (await res.json()) as GatewaySignedDataResponse;
          const payload = json.data ?? (
            json.status === "completed" ? (json as unknown as GatewaySignedData) : undefined
          );
          if (json.status === "completed" && payload) {
            return toResult(payload, {
              sourceId,
              registryVersion,
              timestamp,
              signaturesRequired,
              bitmap,
            });
          }
          lastError = new Error(`Gateway returned status: ${json.status}`);
        } catch (err) {
          // An unpayable or refused source is terminal — never retried blindly.
          if (err instanceof UpstreamPaymentRequiredError) throw err;
          if (
            err instanceof GatewayError &&
            (err.status === 400 || err.status === 401 || err.status === 402)
          ) {
            throw err;
          }
          lastError = err; // timeout / network / identity lookup → next endpoint
        }
      }
      // A requote invalidates this attempt's body for every endpoint alike.
      if (requote) continue;
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Gateway round failed after retries");
  }

  /**
   * Resolve the round inputs, fetching only the fields absent from `cached`.
   * Registry version, redundancy buffer and node count are treated as a unit (one
   * snapshot read). The node list is fetched only when `needNodes` (private API
   * encryption) or when nothing else can tell us the node count.
   */
  private async resolveContext(
    cached: Partial<RoundContext> | undefined,
    needNodes: boolean,
  ): Promise<ResolvedRound> {
    const hasRegistry =
      cached?.registryVersion !== undefined && cached?.redundancyBuffer !== undefined;
    const registryPromise: Promise<RegistrySelectionConfig> = hasRegistry
      ? Promise.resolve({
          registryVersion: cached.registryVersion!,
          redundancyBuffer: cached.redundancyBuffer!,
          ...(cached.nodeCount !== undefined ? { nodeCount: cached.nodeCount } : {}),
        })
      : this.getRegistrySelectionConfig();

    if (cached?.nodes !== undefined) {
      return { ...(await registryPromise), nodes: cached.nodes };
    }
    if (needNodes) {
      const [registry, nodes] = await Promise.all([registryPromise, this.getNodes()]);
      return { ...registry, nodes };
    }
    const registry = await registryPromise;
    if (registry.nodeCount !== undefined) return registry;
    return { ...registry, nodes: await this.getNodes() };
  }

  /** Gateway PDA bytes for an endpoint, cached per URL. A failed lookup is not cached. */
  private resolveGatewayPda(
    endpoint: GatewayEndpoint,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    let pending = this.gatewayPdas.get(endpoint.url);
    if (!pending) {
      pending = this.lookupGatewayPda(endpoint, timeoutMs).catch((err: unknown) => {
        this.gatewayPdas.delete(endpoint.url);
        throw err;
      });
      this.gatewayPdas.set(endpoint.url, pending);
    }
    return pending;
  }

  private async lookupGatewayPda(
    endpoint: GatewayEndpoint,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    const authority =
      endpoint.gatewayAuthority ??
      (await this.fetchGatewayInfo(endpoint, timeoutMs)).gatewayAuthority;
    return deriveGatewayPda(authority, this.programId);
  }

  private async firstReachableData<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint.url}${path}`, { method: "GET" });
        if (res.ok) {
          return unwrapEnvelope(await res.json(), path, res.status) as T;
        }
        lastError = new GatewayError(`GET ${path} failed (${res.status})`, res.status);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
  }

  private async post(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    return this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs?: number,
  ): Promise<Response> {
    if (timeoutMs === undefined) {
      return fetch(url, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertSignaturesRequired(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new RangeError(`signaturesRequired must be an integer in 1..255, got ${value}`);
  }
  return value;
}

/** Unwrap the gateway `{ status, data }` envelope; passes bare payloads through. */
function unwrapEnvelope(json: unknown, path: string, status?: number): unknown {
  if (json && typeof json === "object" && "data" in json) {
    const wrapped = json as Partial<GatewayEnvelope<unknown>>;
    if (wrapped.data === undefined) {
      throw new GatewayError(`GET ${path} returned malformed payload`, status);
    }
    return wrapped.data;
  }
  return json;
}

function selectedNodesForPrivateApiEncryption(
  nodes: Node[],
  selectedIndexes: number[],
): Node[] {
  if (!Array.isArray(nodes)) {
    throw new Error("Private API encryption requires a gateway node array");
  }
  if (selectedIndexes.length === 0) {
    throw new Error("Private API encryption requires at least one selected node");
  }

  const selectedIndexSet = new Set<number>();
  for (const index of selectedIndexes) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Private API encryption selected index must be a non-negative integer: ${index}`,
      );
    }
    if (selectedIndexSet.has(index)) {
      throw new Error(`Private API encryption selected index is duplicated: ${index}`);
    }
    selectedIndexSet.add(index);
  }

  const selectedByIndex = new Map<number, Node>();
  const nodeIndexes = new Set<number>();
  for (const node of nodes) {
    if (!Number.isInteger(node.index) || node.index < 0) {
      throw new Error(`Gateway node index must be a non-negative integer: ${node.index}`);
    }
    if (node.index >= nodes.length) {
      throw new Error(
        `Gateway node index ${node.index} is outside the node list range 0..${nodes.length - 1}`,
      );
    }
    if (nodeIndexes.has(node.index)) {
      throw new Error(`Gateway returned duplicate node index: ${node.index}`);
    }
    nodeIndexes.add(node.index);
    if (!selectedIndexSet.has(node.index)) continue;
    selectedByIndex.set(node.index, node);
  }

  const selectedSigningKeys = new Set<string>();
  return selectedIndexes.map((index) => {
    const node = selectedByIndex.get(index);
    if (!node) {
      throw new Error(`Gateway node list is missing selected node index: ${index}`);
    }
    const signingKey = normalizeSecp256k1PublicKeyHex(
      node.signingKey,
      `Gateway selected node ${index} signingKey`,
    );
    if (selectedSigningKeys.has(signingKey)) {
      throw new Error(`Gateway returned duplicate selected node signingKey: ${index}`);
    }
    selectedSigningKeys.add(signingKey);
    return node;
  });
}

function formatGatewayErrorMessage(
  prefix: string,
  status: number,
  detail?: string,
): string {
  if (!detail) return `${prefix} (${status})`;
  return `${prefix} (${status}): ${detail}`;
}

async function parseGatewayErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).trim();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const message = record.error ?? record.message ?? record.detail;
        if (typeof message === "string" && message.trim()) return message.trim();
      }
    } catch {
      // fall back to raw body below
    }
    return text;
  } catch {
    return undefined;
  }
}

function normalizeHex(value: string): string {
  return (value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value).toLowerCase();
}

/**
 * Shape the gateway payload into a `DataUpdateResult`. `sourceId` and
 * `signaturesRequired` must echo the request (they key the feed and the signed
 * message); `timestamp`, `registryVersion` and `signersBitmap` are taken from the
 * response because a non-fresh (cached) attestation legitimately carries the earlier
 * round's values.
 */
function toResult(
  data: GatewaySignedData,
  ctx: {
    sourceId: string;
    registryVersion: number;
    timestamp: number;
    signaturesRequired: number;
    bitmap: Uint8Array;
  },
): DataUpdateResult {
  if (data.sourceId !== undefined && normalizeHex(data.sourceId) !== ctx.sourceId) {
    throw new GatewayError(
      `Gateway response sourceId ${data.sourceId} does not match the requested ${ctx.sourceId}`,
    );
  }
  if (
    data.signaturesRequired !== undefined &&
    data.signaturesRequired !== ctx.signaturesRequired
  ) {
    throw new GatewayError(
      `Gateway response signaturesRequired ${data.signaturesRequired} does not match the requested ${ctx.signaturesRequired}`,
    );
  }
  return {
    sourceId: ctx.sourceId,
    value: data.value ?? "",
    valuePacked: data.valuePacked ?? "",
    timestamp: data.timestamp ?? ctx.timestamp,
    registryVersion: data.registryVersion ?? ctx.registryVersion,
    signaturesRequired: ctx.signaturesRequired,
    signersBitmap: data.signersBitmap ?? bytesToHex(ctx.bitmap),
    s: data.s ?? "",
    commitmentAddr: data.commitmentAddr ?? "",
    fresh: data.fresh ?? true,
  };
}
