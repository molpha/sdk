/**
 * Paying an API source that is itself x402-paywalled.
 *
 * The caller pays the source directly, from their own wallet on the source's
 * network. Molpha never holds, signs for, or converts those funds, and the
 * Molpha side of the round is unchanged: a paid source still costs exactly one
 * round of subscription quota, and source payment never enters `sourceId`.
 */
import { randomBytes } from "@noble/hashes/utils.js";
import { base64ToBytes, bytesToBase64, bytesToHex0x, utf8 } from "../core/encoding.js";
import { effectiveSelectionSize } from "../core/selection.js";
import type {
  APIConfig,
  AssetDomain,
  EvmSigner,
  UpstreamQuote,
  UpstreamTerms,
} from "../core/types.js";
import { transferWithAuthorizationDigest, toChecksumAddress } from "../evm/eip712.js";
import { resolveAPIConfig } from "./encryption.js";

/**
 * Payment networks whose authorizations this SDK can sign. Beta is Base USDC;
 * the asset is pinned because the caller signs a transfer from their own wallet
 * and the token contract is the EIP-712 verifying contract.
 */
const NETWORKS: Record<string, { chainId: number; usdc: string }> = {
  "eip155:8453": { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "eip155:84532": { chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  // x402 v1 network names.
  base: { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};

/** Raised when a round needs source payment the caller cannot or did not make. */
export class UpstreamPaymentRequiredError extends Error {
  constructor(
    readonly quote: UpstreamQuote,
    message?: string,
  ) {
    super(
      message ??
        `API source requires payment for up to ${quote.eligibleSetSize} fetches: ${quote.resource}`,
    );
    this.name = "UpstreamPaymentRequiredError";
  }
}

/**
 * Number of source fetches this round may perform, and so authorizations to
 * sign: `min(signaturesRequired + redundancyBuffer, nodeCount)`. Identical to
 * the round's selection size — the eligible set *is* the set that fetches.
 */
export function eligibleSetSize(
  signaturesRequired: number,
  registry: { nodeCount: number; redundancyBuffer: number },
): number {
  return effectiveSelectionSize(
    signaturesRequired,
    registry.redundancyBuffer,
    registry.nodeCount,
  );
}

/** Reads a gateway 402 body and returns the relayed upstream quote, if any. */
export function parseUpstreamQuote(envelope: unknown): UpstreamQuote | null {
  if (!envelope || typeof envelope !== "object") return null;
  const extensions = (envelope as { extensions?: unknown }).extensions;
  if (!extensions || typeof extensions !== "object") return null;
  const quote = (extensions as { upstream?: unknown }).upstream;
  if (!quote || typeof quote !== "object") return null;
  return typeof (quote as UpstreamQuote).eligibleSetSize === "number"
    ? (quote as UpstreamQuote)
    : null;
}

/** One `accepts` entry of a source's 402 envelope. */
interface Offer {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
  maxTimeoutSeconds?: string | number;
  extra?: { name?: string; version?: string };
}

/** Picks the one offer this SDK can sign, and validates it before any signing. */
function selectTerms(
  envelope: Record<string, unknown>,
  resource: string,
  assetDomain?: AssetDomain,
): UpstreamTerms {
  const version = envelope.x402Version === 1 ? 1 : 2;
  const offers: Offer[] = Array.isArray(envelope.accepts) ? envelope.accepts : [];
  if (offers.length === 0) {
    throw new Error(`Source 402 for ${resource} advertised no payment terms`);
  }

  const supported = offers.find(
    (o) => o.scheme === "exact" && NETWORKS[String(o.network)] !== undefined,
  );
  if (!supported) {
    const seen = offers.map((o) => `${o.scheme}/${o.network}`).join(", ");
    throw new Error(
      `Source ${resource} requires an unsupported payment scheme or network (${seen}); this SDK signs exact payments on Base USDC only`,
    );
  }

  const network = NETWORKS[String(supported.network)]!;
  const asset = String(supported.asset ?? "");
  if (asset.toLowerCase() !== network.usdc.toLowerCase()) {
    throw new Error(
      `Source ${resource} asks to be paid in ${asset} on ${supported.network}; this SDK signs USDC (${network.usdc}) only`,
    );
  }

  const domain =
    assetDomain ??
    (supported.extra?.name && supported.extra?.version
      ? { name: String(supported.extra.name), version: String(supported.extra.version) }
      : undefined);
  if (!domain) {
    throw new Error(
      `Source ${resource} omitted extra.name/extra.version for ${asset}; supply sourcePayment.assetDomain to sign against it`,
    );
  }

  const amount = String(supported.amount ?? supported.maxAmountRequired ?? "");
  if (!/^\d+$/.test(amount)) {
    throw new Error(`Source ${resource} quoted a non-integer price: ${amount}`);
  }
  const payTo = String(supported.payTo ?? "");
  if (!payTo) throw new Error(`Source ${resource} omitted payTo`);

  return {
    x402Version: version,
    // Echoed verbatim in the signed payload, so it must stay the source's own object.
    requirements: supported as Record<string, unknown>,
    network: String(supported.network),
    chainId: network.chainId,
    asset,
    payTo,
    amount,
    maxTimeoutSeconds: Number(supported.maxTimeoutSeconds ?? 60),
    domain,
    resource,
  };
}

/** Decodes an x402 envelope from the `PAYMENT-REQUIRED` header, or the body. */
function decodeEnvelope(headerValue: string | null, body: string): Record<string, unknown> {
  if (headerValue) {
    try {
      return JSON.parse(
        new TextDecoder().decode(base64ToBytes(headerValue)),
      ) as Record<string, unknown>;
    } catch {
      // Fall through to the body, which carries the same object.
    }
  }
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * Validates caller-supplied terms with the same allowlist and structural checks
 * as {@link probeSource}. Returns canonical {@link UpstreamTerms} derived from
 * `terms.requirements`, not the caller's top-level fields.
 */
export function validateSuppliedTerms(
  terms: UpstreamTerms,
  resource: string,
  assetDomain?: AssetDomain,
): UpstreamTerms {
  return selectTerms(
    {
      x402Version: terms.x402Version,
      accepts: [terms.requirements as Offer],
    },
    resource,
    assetDomain,
  );
}

/**
 * Fetch the source unpaid to read its own x402 terms. This is a price fetch,
 * not a data fetch: nodes remain the only fetchers of the value itself.
 * Returns `null` when the source is not paywalled.
 */
export async function probeSource(
  apiConfig: APIConfig,
  options: { secrets?: Record<string, string>; assetDomain?: AssetDomain; timeoutMs?: number } = {},
): Promise<UpstreamTerms | null> {
  const resolved = options.secrets ? resolveAPIConfig(apiConfig, options.secrets) : apiConfig;

  const init: RequestInit = {
    method: resolved.method ?? "GET",
    headers: resolved.headers ?? {},
  };
  let res: Response;
  if (options.timeoutMs === undefined) {
    res = await fetch(resolved.url, init);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      res = await fetch(resolved.url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  if (res.status !== 402) return null;

  // Probe against the placeholder URL so the terms describe the declared source.
  return selectTerms(
    decodeEnvelope(res.headers.get("PAYMENT-REQUIRED"), await res.text()),
    apiConfig.url,
    options.assetDomain,
  );
}

/**
 * Sign one x402 payment authorization per eligible node.
 *
 * Sign the whole eligible set. Only authorizations a node actually spends ever
 * settle, so unused ones cost nothing, while signing fewer starves buffer nodes
 * and raises the round's failure probability. Every authorization carries a
 * unique nonce, which is what prevents one from settling twice.
 */
export async function signSourcePayments(
  terms: UpstreamTerms,
  signer: EvmSigner,
  count: number,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Cannot sign ${count} source payments`);
  }

  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 600);
  const validBefore = String(now + Math.max(terms.maxTimeoutSeconds, 60));

  const payments: string[] = [];
  for (let i = 0; i < count; i++) {
    const authorization = {
      from: toChecksumAddress(signer.address),
      to: toChecksumAddress(terms.payTo),
      value: terms.amount,
      validAfter,
      validBefore,
      nonce: bytesToHex0x(randomBytes(32)),
    };
    const digest = transferWithAuthorizationDigest(
      {
        name: terms.domain.name,
        version: terms.domain.version,
        chainId: terms.chainId,
        verifyingContract: terms.asset,
      },
      authorization,
    );
    const signature = bytesToHex0x(await signer.signDigest(digest));

    const payload =
      terms.x402Version === 1
        ? {
            x402Version: 1,
            scheme: "exact",
            network: terms.network,
            payload: { signature, authorization },
          }
        : {
            x402Version: 2,
            accepted: terms.requirements,
            payload: { signature, authorization },
          };
    payments.push(bytesToBase64(utf8(JSON.stringify(payload))));
  }
  return payments;
}
