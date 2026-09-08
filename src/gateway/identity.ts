/**
 * Gateway on-chain identity. The request-auth hash binds the Gateway PDA
 * (`["molpha_gateway", gatewayAuthority]`), so the client must know which gateway it is
 * talking to. Kit-only — no `@anchor-lang/core` / web3.js on the gateway path.
 */
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { utf8 } from "../core/encoding.js";

const SEED_GATEWAY = utf8("molpha_gateway");
const addressEncoder = getAddressEncoder();

/** One gateway endpoint plus, optionally, the authority key its `Gateway` PDA derives from. */
export interface GatewayEndpoint {
  /** Base URL, e.g. `https://gateway.example.com` (trailing slash ignored). */
  url: string;
  /**
   * Base58 Solana pubkey of the gateway's signing authority. When omitted the client
   * fetches it once from `GET {url}/v1/info` (`data.gatewayAuthority`) the first time an
   * authenticated request targets this endpoint.
   */
  gatewayAuthority?: string;
}

export type GatewayEndpointInput = string | GatewayEndpoint;

/** Payload of `GET /v1/info` (inside the usual `{ status, data }` envelope). */
export interface GatewayInfo {
  gatewayAuthority: string;
  /** Program id the gateway settles against; must match the client's when present. */
  programId?: string;
}

export function normalizeEndpoint(input: GatewayEndpointInput): GatewayEndpoint {
  const endpoint: GatewayEndpoint = typeof input === "string" ? { url: input } : { ...input };
  endpoint.url = endpoint.url.replace(/\/$/, "");
  if (!endpoint.url) throw new Error("Gateway endpoint url must not be empty");
  return endpoint;
}

/** 32-byte form of a base58 address. */
export function addressToBytes(value: string): Uint8Array {
  return Uint8Array.from(addressEncoder.encode(address(value)));
}

/** `["molpha_gateway", gatewayAuthority]` under `programId`, as a base58 address. */
export async function deriveGatewayPdaAddress(
  gatewayAuthority: string,
  programId: string,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [SEED_GATEWAY, addressToBytes(gatewayAuthority)],
  });
  return pda;
}

/** 32-byte Gateway PDA — the `gateway` field of `RequestAuth`. */
export async function deriveGatewayPda(
  gatewayAuthority: string,
  programId: string,
): Promise<Uint8Array> {
  return addressToBytes(await deriveGatewayPdaAddress(gatewayAuthority, programId));
}

/** Validate an unwrapped `/v1/info` payload. */
export function parseGatewayInfo(data: unknown): GatewayInfo {
  if (!data || typeof data !== "object") {
    throw new Error("GET /v1/info returned malformed payload");
  }
  const record = data as Record<string, unknown>;
  const gatewayAuthority = record.gatewayAuthority;
  if (typeof gatewayAuthority !== "string" || !gatewayAuthority) {
    throw new Error("GET /v1/info payload is missing gatewayAuthority");
  }
  const programId = record.programId;
  if (programId !== undefined && typeof programId !== "string") {
    throw new Error("GET /v1/info programId must be a base58 string");
  }
  return programId === undefined ? { gatewayAuthority } : { gatewayAuthority, programId };
}
