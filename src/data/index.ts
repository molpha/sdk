/**
 * `data` — a browser-safe client for Molpha Data (`https://data.molpha.io`): the template catalog,
 * source derivation, unsigned reads, and signed reads that pass the caller's own authorization to the
 * gateway. `@noble` only: no Anchor, bn.js, `@solana/kit` or Node built-ins.
 *
 * The service expands templates (decision D2); this client never does. It re-hashes every source the
 * service returns and refuses one whose canonical bytes do not hash to the `sourceId` it was given, so
 * a value is never shown for a source it does not belong to. For a signed read it also checks that the
 * attestation is for that source and value, and that the EVM and Starknet calldata the service built
 * are the bytes this SDK would build.
 *
 * Signed reads can also go straight to the gateway with the derived source: `derive()` returns the
 * parsed source, which `MolphaSDK.requestSignedData` takes like any other.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { parseSource, type ParsedSource } from "../core/source.js";
import { formatValue } from "../core/sourcebuild.js";
import type { Attestation } from "../core/types.js";
import { buildEvmVerifierArgs, encodeEvmVerifyCalldata } from "../evm/helpers.js";
import { buildStarknetVerifierArgs, encodeStarknetVerifyCalldata } from "../starknet/helpers.js";
import { hashRequestAuth } from "../gateway/auth.js";

export const MOLPHA_DATA_URL = "https://data.molpha.io";

// ---------------------------------------------------------------------------------------------
// Wire types (molpha-data openapi.json)
// ---------------------------------------------------------------------------------------------

export interface TemplateParam {
  name: string;
  /** chain, finality, address, uint, enum, addressList, bytes32, text */
  type: string;
  required?: boolean;
  default?: string;
  enum?: string[];
  doc: string;
}

export interface Template {
  id: string;
  version: number;
  /** "id@version" */
  ref: string;
  class: string;
  title: string;
  summary: string;
  kinds: string[];
  /** Served chains (CAIP-2) this template reads. */
  chains: string[];
  params: TemplateParam[];
  returns: string;
  caveats?: string[];
  example: Record<string, string>;
  /** The typed shortcut, when there is one. */
  path?: string;
}

export interface Finality {
  mode?: string;
  lagMs?: number;
  n?: number;
  commitment?: string;
  maxAgeMs?: number;
}

export interface DataChain {
  id: string;
  alias?: string;
  kind: string;
  name: string;
  blockTimeMs?: number;
  maxLagMs?: number;
  served: boolean;
  profiles: Record<string, Finality>;
}

/** A template with parameters, or a raw source document. */
export type DataRequest =
  | { template: string; params?: Record<string, string>; source?: never }
  | { source: object; template?: never; params?: never };

export interface DerivedSource {
  sourceId: string;
  /** The canonical source document. */
  source: object;
  canonical: string;
  mode: "exact" | "tolerance";
  template?: string;
  params?: Record<string, string>;
  chain?: string;
  facts?: Record<string, string>;
  /** The document parsed and re-hashed by this SDK; pass it to `MolphaSDK.requestSignedData`. */
  parsed: ParsedSource;
}

export interface PayloadField {
  name: string;
  offset: number;
  length: number;
  type: string;
  decimals?: number;
}

export interface Envelope {
  template: string | null;
  params: Record<string, unknown> | null;
  mode: "exact" | "tolerance";
  data: { value: string; encoded: string; type: string; decimals: number | null };
  facts: Record<string, string> | null;
  source: { sourceId: string; config: object };
  read: {
    chain?: string;
    timestampMs: number;
    blocks: Record<string, number> | null;
    finality?: string;
    observedAt?: string;
    inputs: unknown[] | null;
    cached: boolean;
  };
  signed: boolean;
  attestation: {
    value: string;
    sourceId: string;
    registryVersion: number;
    signaturesRequired: number;
    timestamp: number;
  } | null;
  signature: { signature: string; commitment: string; signersBitmap: string } | null;
  verifierArgs: {
    maxAge: number;
    evm: { function: string; calldata: string };
    starknet: { entrypoint: string; selector: string; calldata: string[] };
    solana: {
      programId?: string;
      instruction: string;
      data: string | null;
      coalitionKey: { x: string; y: string } | null;
      rawValue: string | null;
      note?: string;
    };
  } | null;
  payload: string | null;
  paymentReceipt: string | null;
  round: {
    id: string;
    path: "session" | "requestAuth" | "x402";
    attempts: number;
    fresh: boolean;
    gateway: string;
    check: { signature: "valid" | "invalid" | "unchecked"; reason?: string };
  } | null;
  layout?: PayloadField[] | unknown[];
  /** Decoded from `payload` by the service: recomputed, not signed. */
  fields?: Record<string, string>;
}

export interface SnapshotRead {
  type: "call" | "storage" | "account";
  to?: string;
  sig?: string;
  args?: string[];
  data?: string;
  length?: number;
  address?: string;
  slot?: string;
  contract?: string;
  selector?: string;
  calldata?: string[];
  felts?: number;
  offset?: number;
}

export interface VerifyResult {
  valid: boolean | null;
  registryVersion: number;
  signaturesRequired: number;
  signerCount: number;
  roundId: string;
  payloadMatches?: boolean;
  local: { signature: string; reason?: string };
  chains: {
    chain: string;
    verifier: string;
    success: boolean | null;
    code: number | null;
    reason?: string;
    error?: string;
    maxAge: number;
    elapsedMs: number;
  }[];
}

export interface BatchResult {
  index: number;
  status: number;
  envelope?: Envelope;
  error?: DataErrorBody;
}

export interface DataErrorBody {
  code: string;
  message: string;
  stage?: string;
  input?: string;
  likelyDiverged?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A refusal by the service (or, for 402, the gateway's x402 quote passed through). */
export class MolphaDataError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: {
      stage?: string;
      input?: string;
      likelyDiverged?: boolean;
      /** Seconds, from Retry-After. */
      retryAfter?: number;
      /** x402: the gateway's PAYMENT-REQUIRED header (base64), to pay and resend. */
      paymentRequired?: string;
      /** x402: the gateway's 402 body. */
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "MolphaDataError";
  }
}

/** The service returned something that does not check out: never use the value. */
export class DataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataIntegrityError";
  }
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const hex = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function bytesOf(h: string): Uint8Array {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new DataIntegrityError(`not hex: ${h.slice(0, 20)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Check an envelope against itself: the source re-hashes to its `sourceId`; `data.type` and
 * `data.decimals` are the source's declared output and `data.value` is `data.encoded` rendered by it;
 * a `keccak256` output's `payload` hashes to the value (and no other output carries one); a signed
 * envelope's attestation names this source and this value, and its EVM and Starknet calldata are what
 * this SDK builds. Returns the parsed source.
 *
 * It does not verify the aggregate signature: an on-chain verifier is the authority (`verifierArgs`),
 * or `MolphaDataClient.verify` asks the service and the configured verifier contracts.
 */
export function checkEnvelope(env: Envelope): ParsedSource {
  let parsed: ParsedSource;
  try {
    parsed = parseSource(env.source.config);
  } catch (err) {
    throw new DataIntegrityError(`the returned source is not a valid source: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!same(parsed.idHex, env.source.sourceId)) {
    throw new DataIntegrityError(`the returned source hashes to ${parsed.idHex}, not to the sourceId ${env.source.sourceId}`);
  }
  // What is shown and decoded follows the parsed source, never the response's own description of it.
  const out = parsed.output;
  if (env.data.type !== out.type) {
    throw new DataIntegrityError(`data.type is ${env.data.type}, but the source's output is ${out.type}`);
  }
  const numeric = out.type === "int256" || out.type === "uint256";
  if (numeric && env.data.decimals !== out.decimals) {
    throw new DataIntegrityError(`data.decimals is ${env.data.decimals}, but the source's output has ${out.decimals}`);
  }
  let rendered: string;
  try {
    rendered = formatValue(env.data.encoded, out);
  } catch {
    throw new DataIntegrityError("data.encoded is not a 32-byte value");
  }
  if (rendered !== env.data.value) {
    throw new DataIntegrityError(`data.value ${env.data.value} is not the encoded value, which renders as ${rendered}`);
  }
  if (env.payload != null) {
    if (out.type !== "keccak256") throw new DataIntegrityError("a payload on a source whose output is not keccak256");
    if (!same(hex(keccak_256(bytesOf(env.payload))), env.data.encoded)) {
      throw new DataIntegrityError("the payload does not hash to the value");
    }
  }
  if (env.signed) {
    const a = env.attestation;
    const s = env.signature;
    if (!a || !s) throw new DataIntegrityError("a signed envelope without an attestation");
    if (!same(a.sourceId, env.source.sourceId)) throw new DataIntegrityError("the attestation is for another source");
    if (!same(a.value, env.data.encoded)) throw new DataIntegrityError("the attestation signs another value");
    if (env.verifierArgs) {
      const att = toAttestation(env);
      const maxAge = env.verifierArgs.maxAge;
      if (!same(encodeEvmVerifyCalldata(buildEvmVerifierArgs(att, { maxAge })), env.verifierArgs.evm.calldata)) {
        throw new DataIntegrityError("the EVM verify calldata is not the attestation's");
      }
      const felts = encodeStarknetVerifyCalldata(buildStarknetVerifierArgs(att, { maxAge }));
      const got = env.verifierArgs.starknet.calldata;
      if (felts.length !== got.length || felts.some((f, i) => BigInt(f) !== BigInt(got[i]!))) {
        throw new DataIntegrityError("the Starknet verify calldata is not the attestation's");
      }
    }
  }
  return parsed;
}

/** A response to a signed request must be signed: refuse an unsigned envelope in its place. */
function requireSigned(env: Envelope): Envelope {
  if (!env.signed || !env.attestation || !env.signature) {
    throw new DataIntegrityError("a signed read was requested, and the service answered with an unsigned envelope");
  }
  return env;
}

/**
 * A signed envelope as the SDK's `Attestation`, for `submitAttestation` on Solana or the EVM and
 * Starknet argument builders.
 */
export function toAttestation(env: Envelope): Attestation {
  if (!env.signed || !env.attestation || !env.signature) throw new DataIntegrityError("not a signed envelope");
  return {
    payload: { ...env.attestation },
    signature: {
      s: env.signature.signature,
      commitmentAddr: env.signature.commitment,
      signersBitmap: env.signature.signersBitmap,
    },
    // Rendered here from the signed bytes and the source (checkEnvelope holds data.value to the same).
    value: formatValue(env.data.encoded, parseSource(env.source.config).output),
    fresh: env.round?.fresh ?? true,
    ...(env.payload ? { valuePreimage: env.payload } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Payload fields (decision D6)
// ---------------------------------------------------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}

function unbase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new RangeError(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function bigBE(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function decimal(n: bigint, decimals = 0): string {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString();
  if (decimals > 0) {
    s = s.padStart(decimals + 1, "0");
    s = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  }
  return (neg ? "-" : "") + s;
}

/**
 * Decode a payload with its layout, as the service does: the fields of a snapshot, recomputed from
 * the signed preimage. Check `keccak256(payload)` against the verified value first (`checkEnvelope`).
 */
export function decodePayload(layout: PayloadField[], payload: string | Uint8Array): Record<string, string> {
  const p = typeof payload === "string" ? bytesOf(payload) : payload;
  const out: Record<string, string> = {};
  for (const f of layout) {
    if (f.offset < 0 || f.length <= 0 || f.offset + f.length > p.length) {
      throw new RangeError(`field ${f.name} (${f.offset}+${f.length}) is outside the ${p.length}-byte payload`);
    }
    const b = p.subarray(f.offset, f.offset + f.length);
    const le = () => bigBE(Uint8Array.from(b).reverse());
    switch (f.type) {
      case "uint":
        out[f.name] = decimal(bigBE(b), f.decimals);
        break;
      case "int": {
        let n = bigBE(b);
        if (b[0]! & 0x80) n -= 1n << BigInt(8 * b.length);
        out[f.name] = decimal(n, f.decimals);
        break;
      }
      case "u256felts":
        out[f.name] = decimal((bigBE(b.subarray(32)) << 128n) + bigBE(b.subarray(0, 32)), f.decimals);
        break;
      case "u8":
      case "u16le":
      case "u32le":
      case "u64le":
      case "u128le":
        out[f.name] = decimal(le(), f.decimals);
        break;
      case "i32le": {
        const n = Number(le());
        out[f.name] = String(n | 0);
        break;
      }
      case "address":
        out[f.name] = hex(b.subarray(b.length - 20));
        break;
      case "pubkey":
        out[f.name] = base58(b);
        break;
      case "optionPubkey":
        out[f.name] = b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 ? "" : base58(b.subarray(4, 36));
        break;
      case "bool":
        out[f.name] = String(b[b.length - 1] !== 0);
        break;
      case "bytes":
        out[f.name] = hex(b);
        break;
      default:
        throw new RangeError(`field ${f.name}: unknown type ${f.type}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// RequestAuth
// ---------------------------------------------------------------------------------------------

/**
 * The digest a consumer signs (Ed25519) for a RequestAuth signed read: keccak256("MOLPHA_REQAUTH_V1" ||
 * programId || gatewayPda || sourceId || u8 signatures || u64le authTimestamp). Read `programId` and
 * `gatewayPda` from the gateway's `GET /v1/info`, and the sourceId from `derive()`.
 */
export function requestAuthDigest(fields: {
  programId: string;
  gatewayPda: string;
  sourceId: string;
  signatures: number;
  /** Unix seconds at signing. */
  authTimestamp: number | bigint;
}): Uint8Array {
  return hashRequestAuth({
    programId: unbase58(fields.programId),
    gateway: unbase58(fields.gatewayPda),
    sourceId: fields.sourceId,
    signaturesRequired: fields.signatures,
    authTimestamp: fields.authTimestamp,
  });
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

/** How a signed read is paid: the caller's own session, RequestAuth or x402 payment. */
export type SignedReadAuth =
  | { bearer: string }
  | {
      requestAuth: {
        consumerAuthority: string;
        /** Defaults to consumerAuthority (the owner signs); set it when a delegate signs. */
        subscriptionOwner?: string;
        /** base58 or 0x hex Ed25519 signature over `requestAuthDigest`. */
        authSig: string;
        authTimestamp: number;
      };
    }
  | { payment: string }
  /** x402 without a payment: the call fails with the gateway's 402 quote (`detail.paymentRequired`). */
  | { x402: true };

export interface ReadOptions {
  /** signaturesRequired of a signed read (default 3). */
  signatures?: number;
  /** Seconds written into the EVM and Starknet verify calldata (default 300). */
  verifierMaxAge?: number;
  signal?: AbortSignal;
}

export interface MolphaDataClientOptions {
  /** Default `https://data.molpha.io`. */
  baseUrl?: string;
  /** Sent as X-API-Key: a higher rate limit than the anonymous tier. */
  apiKey?: string;
  fetch?: typeof fetch;
}

export class MolphaDataClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: MolphaDataClientOptions = {}) {
    this.base = (opts.baseUrl ?? MOLPHA_DATA_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async chains(signal?: AbortSignal): Promise<{ chains: DataChain[]; defaultProfile: string }> {
    return this.get("/v1/chains", signal);
  }

  async catalog(filter: { chain?: string; class?: string } = {}, signal?: AbortSignal): Promise<Template[]> {
    const q = new URLSearchParams();
    if (filter.chain) q.set("chain", filter.chain);
    if (filter.class) q.set("class", filter.class);
    const r = await this.get<{ templates: Template[] }>(`/v1/catalog${q.size ? `?${q}` : ""}`, signal);
    return r.templates;
  }

  async template(id: string, signal?: AbortSignal): Promise<Template> {
    return this.get(`/v1/catalog/${encodeURIComponent(id)}`, signal);
  }

  /** The canonical source and its sourceId, re-hashed here; nothing is read from chain. */
  async derive(req: DataRequest, signal?: AbortSignal): Promise<DerivedSource> {
    const d = await this.post<Omit<DerivedSource, "parsed">>("/v1/sources/derive", req, {}, signal);
    let parsed: ParsedSource;
    try {
      parsed = parseSource(d.source);
    } catch (err) {
      throw new DataIntegrityError(`the derived source is not a valid source: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!same(parsed.idHex, d.sourceId)) {
      throw new DataIntegrityError(`the derived source hashes to ${parsed.idHex}, not to the sourceId ${d.sourceId}`);
    }
    return { ...d, parsed };
  }

  /** An unsigned read: the service's own observation, no signature. */
  async read(req: DataRequest, opts: Omit<ReadOptions, "signatures" | "verifierMaxAge"> = {}): Promise<Envelope> {
    const env = await this.post<Envelope>("/v1/read", { ...req, attest: false }, {}, opts.signal);
    checkEnvelope(env);
    return env;
  }

  /** A threshold-signed read through the gateway, paid by `auth`. */
  async readSigned(req: DataRequest, auth: SignedReadAuth, opts: ReadOptions = {}): Promise<Envelope> {
    const body = { ...req, attest: true, signatures: opts.signatures, verifierMaxAge: opts.verifierMaxAge };
    const env = await this.post<Envelope>("/v1/read", body, authHeaders(auth), opts.signal);
    checkEnvelope(requireSigned(env));
    return env;
  }

  /** Up to 16 reads; signed items need a session. Each result is checked like a single read. */
  async batch(
    items: (DataRequest & { attest?: boolean; signatures?: number })[],
    opts: ReadOptions & { attest?: boolean; bearer?: string } = {},
  ): Promise<BatchResult[]> {
    const headers = opts.bearer ? authHeaders({ bearer: opts.bearer }) : {};
    const r = await this.post<{ results: BatchResult[] }>(
      "/v1/read/batch",
      { items, attest: opts.attest, signatures: opts.signatures, verifierMaxAge: opts.verifierMaxAge },
      headers,
      opts.signal,
    );
    items.forEach((item, i) => {
      const result = r.results.find((x) => x.index === i);
      if (!result?.envelope) return;
      if (opts.attest || item.attest) requireSigned(result.envelope);
      checkEnvelope(result.envelope);
    });
    return r.results;
  }

  /** Up to four fixed-length raw reads on one chain under one keccak256 value. */
  async snapshot(
    req: { chain: string; finality?: string; reads: SnapshotRead[] },
    opts: ReadOptions & { auth?: SignedReadAuth } = {},
  ): Promise<Envelope> {
    const body = { ...req, attest: !!opts.auth, signatures: opts.signatures, verifierMaxAge: opts.verifierMaxAge };
    const env = await this.post<Envelope>("/v1/snapshot", body, opts.auth ? authHeaders(opts.auth) : {}, opts.signal);
    checkEnvelope(opts.auth ? requireSigned(env) : env);
    return env;
  }

  /** Ask the service about an attestation: its local check and the configured verifier contracts. */
  async verify(
    env: Pick<Envelope, "attestation" | "signature" | "payload">,
    opts: { maxAge?: number; signal?: AbortSignal } = {},
  ): Promise<VerifyResult> {
    if (!env.attestation || !env.signature) throw new DataIntegrityError("not a signed envelope");
    return this.post(
      "/v1/verify",
      { attestation: env.attestation, signature: env.signature, payload: env.payload ?? undefined, maxAge: opts.maxAge ?? 0 },
      {},
      opts.signal,
    );
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.call<T>(path, { method: "GET", headers: this.headers({}), signal });
  }

  private async post<T>(path: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.call<T>(path, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", ...headers }),
      body: JSON.stringify(body),
      signal,
    });
  }

  private headers(h: Record<string, string>): Record<string, string> {
    return this.opts.apiKey ? { ...h, "x-api-key": this.opts.apiKey } : h;
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    // Never send cookies: the service authenticates with headers only.
    const res = await this.fetchFn(`${this.base}${path}`, { ...init, credentials: "omit" });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new MolphaDataError(res.status, "BAD_RESPONSE", `the service answered HTTP ${res.status} with a body that is not JSON`);
    }
    if (res.ok) return body as T;
    const retry = Number(res.headers.get("retry-after"));
    if (res.status === 402) {
      throw new MolphaDataError(402, "PAYMENT_REQUIRED", "the gateway asks for an x402 payment", {
        paymentRequired: res.headers.get("payment-required") ?? undefined,
        body,
      });
    }
    const e = (body as { error?: DataErrorBody } | undefined)?.error;
    throw new MolphaDataError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `HTTP ${res.status}`, {
      stage: e?.stage,
      input: e?.input,
      likelyDiverged: e?.likelyDiverged,
      retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
  }
}

function authHeaders(auth: SignedReadAuth): Record<string, string> {
  if ("bearer" in auth) return { authorization: `Bearer ${auth.bearer}` };
  if ("payment" in auth) return { "payment-signature": auth.payment };
  if ("requestAuth" in auth) {
    const r = auth.requestAuth;
    return {
      "x-molpha-consumer-authority": r.consumerAuthority,
      "x-molpha-subscription-owner": r.subscriptionOwner ?? r.consumerAuthority,
      "x-molpha-auth-sig": r.authSig,
      "x-molpha-auth-timestamp": String(r.authTimestamp),
    };
  }
  return {};
}
