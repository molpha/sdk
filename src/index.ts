/**
 * `@molpha/sdk` — Consumer SDK public surface.
 *
 * The `MolphaSDK` facade wires the gateway and Solana clients together; consumers
 * who only read or only run gateway rounds can use `sdk.gateway` / `sdk.solana`
 * directly (or import `MolphaGateway` / `MolphaSolanaClient` standalone).
 */
import { address, type Address } from "@solana/kit";
import type { AnchorProvider, Idl } from "@anchor-lang/core";
import {
  type GatewayEndpointInput,
  type RequestSignedDataOptions,
  MolphaGateway,
} from "./gateway/index.js";
import { MolphaSolanaClient } from "./solana/client.js";
import type { Attestation } from "./core/types.js";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { gatewaySignerFromWallet, type MolphaWallet } from "./wallet.js";
import type { SolanaConnection } from "./solana/kit.js";
type Commitment = NonNullable<ConstructorParameters<typeof AnchorProvider>[2]>["commitment"];

// Public re-exports.
export * from "./core/index.js";
export * from "./gateway/index.js";
export * from "./evm/index.js";
export * from "./starknet/index.js";
export * from "./solana/index.js";
export * from "./bulk.js";
export { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
export { gatewaySignerFromWallet, signerFromKeypair, type MolphaWallet } from "./wallet.js";

export interface MolphaSDKOptions {
  /**
   * Defaults to `DEFAULT_GATEWAY_ENDPOINT`. Pass multiple entries for failover. Each
   * entry is a URL or `{ url, gatewayAuthority }`; when the authority is omitted it is
   * discovered from the gateway's `GET /v1/info`.
   */
  endpoints?: GatewayEndpointInput | GatewayEndpointInput[];
  connection: SolanaConnection;
  /** On-chain txs + gateway auth (see `MolphaWallet`). */
  wallet: MolphaWallet;
  /** Defaults to the vendored IDL's program address. Bound into gateway request auth. */
  programId?: Address | string;
  /** Defaults to `MOLPHA_IDL`. Override when pinning a different deployment. */
  idl?: Idl;
  commitment?: Commitment;
}

/**
 * Thrown by {@link MolphaSDK.requestAndSubmit} when the gateway round succeeded but submitting the
 * attestation to Solana failed. The round consumed subscription quota and the signed attestation is
 * valid, so it is carried here: submit `error.result` again (it stays valid until its freshness
 * window passes, and re-submitting it is safe) instead of requesting, and paying for, a new round.
 */
export class SubmitFailedError extends Error {
  constructor(
    /** The signed attestation the gateway returned. */
    readonly result: Attestation,
    override readonly cause: unknown,
  ) {
    super(
      `Gateway round succeeded but submitting the attestation failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SubmitFailedError";
  }
}

export class MolphaSDK {
  readonly gateway: MolphaGateway;
  readonly solana: MolphaSolanaClient;

  constructor(opts: MolphaSDKOptions) {
    const programId = address(String(opts.programId ?? MOLPHA_PROGRAM_ADDRESS));
    this.solana = MolphaSolanaClient.create({
      connection: opts.connection,
      wallet: opts.wallet,
      programId,
      idl: opts.idl ?? MOLPHA_IDL,
      ...(opts.commitment ? { commitment: opts.commitment } : {}),
    });
    this.gateway = new MolphaGateway(
      opts.endpoints,
      () => this.solana.getRegistrySelectionConfig(),
      gatewaySignerFromWallet(opts.wallet),
      {
        defaultSubscriptionOwner: opts.wallet.publicKey.toBase58(),
        programId,
        verifyNodeKeys: (args) => this.solana.verifyNodeKeysForPrivateApi(args),
      },
    );
  }

  /**
   * Request a threshold-signed data update from the gateway (against the current
   * on-chain registry version) and submit it via `submit_attestation`.
   */
  async requestAndSubmit(
    opts: RequestSignedDataOptions,
  ): Promise<{ result: Attestation; signature: string; feed: Address }> {
    const result = await this.gateway.requestSignedData(opts);
    try {
      const { signature, feed } = await this.solana.submitAttestation(result);
      return { result, signature, feed };
    } catch (cause) {
      // The round is already paid for and signed: do not lose it with the failed submit.
      throw new SubmitFailedError(result, cause);
    }
  }
}
