/**
 * `MolphaSolanaClient` — consumer on-chain surface only (subscribe, extend,
 * submitAttestation, readFeed/readPlan/readSubscription/readRegistry,
 * getRegistrySelectionConfig, verifyNodeKeysForPrivateApi). Built from an Anchor
 * `Program` over the vendored IDL (program `3d01170`, "Epoch settlements").
 */
import {
  AnchorProvider,
  Program,
  type Idl,
  type Wallet,
  web3,
} from "@anchor-lang/core";
import { keccak_256 } from "@noble/hashes/sha3.js";
import BN from "bn.js";
import type { Address } from "@solana/kit";
import { type CoalitionKey, computeCoalitionKey } from "../core/coalition.js";
import { bytesToHex, toFixedBytes } from "../core/encoding.js";
import {
  normalizeSecp256k1PublicKeyHex,
  secp256k1PublicKeyFromCoordinates,
} from "../core/nodeKeys.js";
import type {
  Attestation,
  Node,
  NodeKeyVerifierArgs,
  RegistrySelectionConfig,
} from "../core/types.js";
import {
  type RegistryStateView,
  type RegistryView,
  resolveRemainingAccounts,
} from "./accounts.js";
import {
  addressFromBytes,
  getAssociatedTokenAddressSync,
  setComputeUnitLimit,
  setComputeUnitPrice,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  toSolanaAddress,
  type SolanaAccountMeta,
  type SolanaAddress,
  type SolanaConnection,
} from "./kit.js";
import {
  feedPda,
  planPda,
  protocolConfigPda,
  registryPda,
  registryStatePda,
  subscriptionPda,
} from "./pdas.js";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../../idl/index.js";
import { PlanType, planIdFromVariant, planVariant, type PlanId } from "./plans.js";

export { PlanType, type PlanId } from "./plans.js";

/** The most a transaction may request; the fallback when the signer count is unknown. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/**
 * Compute units to request for a `submit_attestation` carrying `signerCount` signatures.
 *
 * The program's LiteSVM benchmark measures the whole transaction at about `43k + 9.1k` units per
 * signer (119k at 8 signers, 155k at 12, 208k at 18), so the old flat 1.4M request was 7-10 times
 * what a typical aggregate uses. That matters once a priority fee is attached, because it is
 * priced per requested unit, and for how the scheduler packs blocks. The estimate adds 15% and a
 * fixed 10k: the program's selection check costs a little more on some registries than the
 * benchmark's, and a limit that is hit fails the transaction for good.
 */
export function estimateSubmitComputeUnits(signerCount: number): number {
  if (!Number.isInteger(signerCount) || signerCount < 1) return MAX_COMPUTE_UNIT_LIMIT;
  const measured = 43_000 + 9_200 * signerCount;
  return Math.min(Math.round(measured * 1.15) + 10_000, MAX_COMPUTE_UNIT_LIMIT);
}

/**
 * Compute-unit limit for one transaction that carries a `submit_attestation` per entry of
 * `signerCounts`: the same margin as {@link estimateSubmitComputeUnits} on the sum, with the fixed
 * 10k once for the transaction.
 */
export function estimateSubmitBatchComputeUnits(signerCounts: number[]): number {
  if (signerCounts.length === 0 || signerCounts.some((n) => !Number.isInteger(n) || n < 1)) {
    return MAX_COMPUTE_UNIT_LIMIT;
  }
  const measured = signerCounts.reduce((sum, n) => sum + 43_000 + 9_200 * n, 0);
  return Math.min(Math.round(measured * 1.15) + 10_000, MAX_COMPUTE_UNIT_LIMIT);
}

/**
 * Bytes of `submit_attestation` instruction data with no raw value: the 8 byte discriminator, the
 * payload (32 + 32 + 4 + 1 + 8), the signature (32 + 20 + 32), the empty `Option` and the coalition
 * key (32 + 32).
 */
export const SUBMIT_INSTRUCTION_DATA_BYTES = 234;

const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

/** Bytes of a compact-u16 length prefix. */
const shortVecBytes = (n: number): number => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/**
 * Serialized size of a legacy transaction with one signature (the fee payer's). It is computed from
 * the compiled message, not by serializing it: web3.js serializes into a fixed 1232 byte buffer and
 * throws for exactly the transactions this has to measure.
 */
function transactionSize(payer: web3.PublicKey, instructions: web3.TransactionInstruction[]): number {
  const tx = new web3.Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = PLACEHOLDER_BLOCKHASH;
  tx.add(...instructions);
  const message = tx.compileMessage();
  const keys = message.accountKeys.length;
  // signatures (count + one), header, account keys, recent blockhash, instruction count
  let size = 1 + 64 + 3 + shortVecBytes(keys) + 32 * keys + 32 + shortVecBytes(message.instructions.length);
  message.instructions.forEach((compiled, i) => {
    const dataBytes = instructions[i]!.data.length;
    size +=
      1 + shortVecBytes(compiled.accounts.length) + compiled.accounts.length + shortVecBytes(dataBytes) + dataBytes;
  });
  return size;
}

/**
 * Serialized size of a transaction with `count` attestations of `signerCount` signers each, to plan
 * a batch before there is one. The signer `Node` accounts are shared between attestations, so the
 * size depends on how many distinct ones there are: `distinctSigners` (default `signerCount`, the
 * best case; the registry's node count is the worst).
 */
export function estimateSubmitTransactionSize(
  count: number,
  signerCount: number,
  opts: { distinctSigners?: number; priorityFee?: boolean } = {},
): number {
  const key = () => web3.Keypair.generate().publicKey;
  const [payer, registry, feed, protocolConfig, program] = [key(), key(), key(), key(), key()];
  const distinct = Math.max(signerCount, opts.distinctSigners ?? signerCount);
  const nodes = Array.from({ length: distinct }, key);
  const instructions: web3.TransactionInstruction[] = [setComputeUnitLimit(1)];
  if (opts.priorityFee) instructions.push(setComputeUnitPrice(1));
  for (let i = 0; i < count; i++) {
    instructions.push(
      new web3.TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: registry, isSigner: false, isWritable: false },
          { pubkey: feed, isSigner: false, isWritable: true },
          { pubkey: protocolConfig, isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(SYSTEM_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
          ...Array.from({ length: signerCount }, (_, j) => ({
            pubkey: nodes[(i * signerCount + j) % distinct]!,
            isSigner: false,
            isWritable: false,
          })),
        ],
        data: Buffer.alloc(SUBMIT_INSTRUCTION_DATA_BYTES),
      }),
    );
  }
  return transactionSize(payer, instructions);
}

/** The most attestations of `signerCount` signers that fit in one transaction; see {@link estimateSubmitTransactionSize}. */
export function maxAttestationsPerTransaction(
  signerCount: number,
  opts: { distinctSigners?: number; priorityFee?: boolean } = {},
): number {
  let count = 0;
  while (estimateSubmitTransactionSize(count + 1, signerCount, opts) <= web3.PACKET_DATA_SIZE) count++;
  return count;
}

/** How long a registry read is reused. A registry version's node list never changes. */
const REGISTRY_CACHE_MS = 30_000;
/** Cap on remembered node keys / coalition keys, so a long-lived client stays bounded. */
const KEY_CACHE_LIMIT = 8_192;
/** How long a recent-prioritization-fee read is reused. */
const PRIORITY_FEE_CACHE_MS = 5_000;
/** Percentile of recent fees for `priorityFeeMicroLamports: "auto"`, and the most it will pay. */
const AUTO_FEE_PERCENTILE = 0.75;
const AUTO_FEE_CAP_MICRO_LAMPORTS = 1_000_000;
type Commitment = NonNullable<ConstructorParameters<typeof AnchorProvider>[2]>["commitment"];

export interface SubscribeResult {
  signature: string;
  /** USDC base units actually debited from the owner for this subscription. */
  pricePaid: bigint;
}

export interface PlanInfo {
  planType: PlanType;
  /** Subscription price in USDC base units (raw u64, e.g. 1_000_000 = 1 USDC at 6 decimals). */
  subscriptionPrice: bigint;
  maxSigners: number;
  maxDelegates: number;
  /** Rounds a subscription on this plan may settle per period. */
  maxRounds: bigint;
  privateApiEnabled: boolean;
  isActive: boolean;
}

/**
 * On-chain `Subscription`. The program does not track usage (round quota is counted by the
 * gateway's off-chain outbox), so there is no on-chain "rounds used" figure to read.
 */
export interface SubscriptionInfo {
  owner: Address;
  planType: PlanType;
  /** Unix timestamp (seconds) until which the subscription is valid. */
  validUntil: bigint;
  /** Round quota per plan snapshot — enforced by the gateway at admission, not on chain. */
  maxRounds: bigint;
  delegateCount: number;
  maxDelegates: number;
  maxSigners: number;
}

export interface SubmitResult {
  signature: string;
  /** Feed PDA written by this submit (`["molpha_feed", sourceId, [signaturesRequired], submitter]`). */
  feed: Address;
}

/** What {@link MolphaSolanaClient.submitAttestations} returns. */
export interface SubmitAttestationsResult extends SubmitResult {
  /** Attestations in the transaction. They were applied in timestamp order. */
  count: number;
}

/**
 * Thrown by {@link MolphaSolanaClient.submitAttestations} when the attestations do not fit in one
 * transaction. Nothing was sent: submit the first `fits` of them (oldest first) and the rest apart.
 */
export class BatchTooLargeError extends RangeError {
  constructor(
    /** How many of the attestations, oldest first, do fit. */
    readonly fits: number,
    /** The serialized size of the whole batch, in bytes. */
    readonly size: number,
    /** The largest transaction the network accepts, in bytes. */
    readonly limit: number,
    readonly count: number,
  ) {
    super(
      `${count} attestations need a ${size} byte transaction, over the ${limit} byte limit; ${fits} fit`,
    );
    this.name = "BatchTooLargeError";
  }
}

/**
 * On-chain `Feed` (Anchor-decoded). `value` is always the signed
 * `AttestationPayload.value` (32 bytes): the oracle value itself when `valueKind` is
 * `value`, or `keccak256(rawValue)` when it is `hash` (the preimage travelled in the
 * submitting instruction). For a tolerance-mode source it is a two's-complement `int256`
 * (see `decodeInt256` / `formatInt256Decimal`).
 */
export interface FeedAccount {
  sourceId: number[];
  value: Uint8Array | number[];
  valueKind: { value: Record<string, never> } | { hash: Record<string, never> };
  submitter: Address;
  /** u64 unix MILLISECONDS (the round's gateway-assigned timestamp). */
  timestamp: BN;
  signaturesRequired: number;
  signersBitmap: number[];
  registryVersion: number;
  bump: number;
}

  /** Anchor-encoded `SubmitAttestationArgs` (camelCase field names). */
export interface SubmitAttestationArgs {
  attestation: {
    payload: {
      value: number[];
      sourceId: number[];
      registryVersion: number;
      signaturesRequired: number;
      timestamp: BN;
    };
    signature: {
      aggSigS: number[];
      commitment: number[];
      signersBitmap: number[];
    };
  };
  /** Optional preimage when `payload.value` is `keccak256(rawValue)`. */
  rawValue: Uint8Array | null;
  coalitionKey: { x: number[]; y: number[] };
}

export interface SubmitAttestationOptions {
  /**
   * Compute-unit limit. Defaults to {@link estimateSubmitComputeUnits} for the aggregate's signer
   * count, not the 1.4M maximum.
   */
  computeUnitLimit?: number;
  /**
   * Priority fee in micro-lamports per compute unit. A number is used as given; `"auto"` takes the
   * 75th percentile of the fees recently paid by transactions that wrote the feed, capped at 1
   * lamport per unit. Omitted: no priority fee, which is right on a quiet cluster. Raise it (or
   * use `"auto"`) when submits are dropped under load.
   */
  priorityFeeMicroLamports?: number | "auto";
  /**
   * Precomputed signer coalition key. When omitted, the client fetches signer `Node`
   * accounts and sums their secp256k1 keys ({@link computeCoalitionKey}).
   */
  coalitionKey?: CoalitionKey;
  /**
   * Optional value preimage (maximum 256 bytes). Its keccak256 digest must equal
   * `attestation.payload.value`; the program stores that digest with `valueKind.hash`.
   */
  rawValue?: Uint8Array;
}

/** Options for {@link MolphaSolanaClient.submitAttestations}. */
export type SubmitAttestationsOptions = Pick<
  SubmitAttestationOptions,
  "computeUnitLimit" | "priorityFeeMicroLamports"
>;

interface NodeAccount {
  secp256k1PubkeyX?: Uint8Array | number[];
  secp256k1PubkeyY?: Uint8Array | number[];
  secp256k1_pubkey_x?: Uint8Array | number[];
  secp256k1_pubkey_y?: Uint8Array | number[];
}

interface CreateClientOpts {
  connection: SolanaConnection;
  wallet: Wallet;
  programId?: SolanaAddress;
  idl?: Idl;
  commitment?: Commitment;
}

export class MolphaSolanaClient {
  // Registry reads and signer keys are shared by every submit that names the same registry
  // version, so a fleet of feeds reads them once. Promises are cached, so concurrent submits
  // coalesce; a failed read is dropped and retried by the next call.
  private readonly registryCache = new Map<number, { at: number; value: Promise<RegistryView> }>();
  private readonly nodeKeyCache = new Map<string, { x: Uint8Array; y: Uint8Array }>();
  private readonly coalitionCache = new Map<string, Promise<CoalitionKey>>();
  private priorityFeeCache?: { at: number; value: Promise<number> };

  private constructor(
    private readonly program: Program,
    private readonly provider: AnchorProvider,
    readonly programId: Address,
  ) {}

  static create(opts: CreateClientOpts): MolphaSolanaClient {
    const programId = toSolanaAddress(opts.programId ?? MOLPHA_PROGRAM_ADDRESS);
    const provider = new AnchorProvider(opts.connection, opts.wallet, {
      commitment: opts.commitment ?? "confirmed",
    });
    // Anchor reads the program id from `idl.address`; override it so the
    // caller-supplied programId always wins without mutating the vendored copy.
    const idl: Idl = { ...(opts.idl ?? MOLPHA_IDL), address: programId };
    const program = new Program(idl, provider);
    return new MolphaSolanaClient(program, provider, programId);
  }

  private get wallet(): Address {
    return toSolanaAddress(this.provider.wallet.publicKey);
  }

  /** Anchor's method/account namespaces are untyped without an IDL type param. */
  private get methods(): any {
    return this.program.methods;
  }
  private get accounts(): any {
    return this.program.account;
  }

  /**
   * Current registry version plus the selection inputs of that snapshot
   * (`redundancy_buffer`, `node_count`). Two account reads: `RegistryState`, then the
   * version-addressed `Registry`. Prefer this over {@link getRegistryVersion} when
   * deriving gateway selection bitmaps.
   */
  async getRegistrySelectionConfig(): Promise<Required<RegistrySelectionConfig>> {
    const state = await this.fetchRegistryState();
    const registry = await this.fetchRegistry(state.currentVersion);
    return {
      registryVersion: state.currentVersion,
      redundancyBuffer: registry.redundancyBuffer,
      nodeCount: registry.nodeCount,
    };
  }

  async getRegistryVersion(): Promise<number> {
    return (await this.fetchRegistryState()).currentVersion;
  }

  /** Read an immutable registry snapshot; defaults to the current version. */
  async readRegistry(version?: number): Promise<RegistryView> {
    const target = version ?? (await this.fetchRegistryState()).currentVersion;
    return this.fetchRegistry(target);
  }

  /** Fetch a plan's on-chain terms, including the USDC `subscriptionPrice` charged on `subscribe`. */
  async getPlan(plan: PlanType): Promise<PlanInfo> {
    const info = await this.readPlan(plan);
    if (!info) {
      throw new Error(`plan account not found for ${PlanType[plan] ?? plan}`);
    }
    return info;
  }

  /** Read a plan account, or `null` if it has not been initialized. */
  async readPlan(plan: PlanType): Promise<PlanInfo | null> {
    const account = await this.accounts.plan.fetchNullable(planPda(plan as PlanId, this.programId));
    return account ? this.decodePlan(account) : null;
  }

  /** Read an owner's subscription, or `null` if they have not subscribed. */
  async readSubscription(owner: SolanaAddress = this.wallet): Promise<SubscriptionInfo | null> {
    const account = await this.accounts.subscription.fetchNullable(
      subscriptionPda(owner, this.programId),
    );
    if (!account) return null;
    return {
      owner: toSolanaAddress(account.owner),
      planType: planIdFromVariant(account.planType) as unknown as PlanType,
      validUntil: BigInt(account.validUntil.toString()),
      maxRounds: BigInt(account.maxRounds.toString()),
      delegateCount: account.delegateCount,
      maxDelegates: account.maxDelegates,
      maxSigners: account.maxSigners,
    };
  }

  /**
   * Subscribe to a plan. This **debits USDC** from the owner: the plan's
   * `subscriptionPrice` is transferred to the protocol treasury on-chain.
   *
   * Payment is explicit and must be confirmed: pass `maxPriceUsdc` (USDC base
   * units) as the most you agree to pay. The SDK reads the live on-chain price
   * and aborts before sending the transaction if it exceeds that amount, so a
   * price change between display and confirmation can never silently overcharge.
   * The amount actually paid is returned as `pricePaid`.
   *
   * Use {@link getPlan} to display the current price to the user beforehand.
   */
  async subscribe(
    plan: PlanType,
    opts: { maxPriceUsdc: bigint | number | BN; ownerUsdc?: SolanaAddress },
  ): Promise<SubscribeResult> {
    const planId = plan as PlanId;
    const owner = this.wallet;
    const { usdcMint, treasury } = await this.fetchProtocolTokens();
    const price = await this.confirmPlanPrice(planId, opts.maxPriceUsdc, "subscribe");
    const ownerUsdc = opts.ownerUsdc ?? getAssociatedTokenAddressSync(usdcMint, owner);

    const signature = await this.methods
      .subscribe(planVariant(planId))
      .accountsPartial({
        owner,
        protocolConfig: protocolConfigPda(this.programId),
        plan: planPda(planId, this.programId),
        subscription: subscriptionPda(owner, this.programId),
        ownerUsdc,
        treasury,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      .rpc();
    return { signature, pricePaid: price };
  }

  /**
   * Extend the current subscription for another period. Like {@link subscribe}
   * this **debits USDC** (the plan's `subscriptionPrice`) and requires explicit
   * payment confirmation via `maxPriceUsdc`.
   */
  async extendSubscription(
    opts: { maxPriceUsdc: bigint | number | BN; ownerUsdc?: SolanaAddress },
  ): Promise<SubscribeResult> {
    const owner = this.wallet;
    const subscription = subscriptionPda(owner, this.programId);
    const sub = await this.accounts.subscription.fetch(subscription);
    const planId = planIdFromVariant(sub.planType);
    const { usdcMint, treasury } = await this.fetchProtocolTokens();
    const price = await this.confirmPlanPrice(planId, opts.maxPriceUsdc, "extendSubscription");
    const ownerUsdc = opts.ownerUsdc ?? getAssociatedTokenAddressSync(usdcMint, owner);

    const signature = await this.methods
      .extendSubscription()
      .accountsPartial({
        owner,
        protocolConfig: protocolConfigPda(this.programId),
        subscription,
        plan: planPda(planId, this.programId),
        ownerUsdc,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      .rpc();
    return { signature, pricePaid: price };
  }

  /**
   * Read the live on-chain plan price and verify it does not exceed the amount
   * the caller agreed to pay. Returns the price (USDC base units) on success.
   */
  private async confirmPlanPrice(
    planId: PlanId,
    maxPriceUsdc: bigint | number | BN,
    method: string,
  ): Promise<bigint> {
    const max = toUsdcBaseUnits(maxPriceUsdc, "maxPriceUsdc");
    const plan = await this.accounts.plan.fetch(planPda(planId, this.programId));
    const price = BigInt(plan.subscriptionPrice.toString());
    if (price > max) {
      throw new Error(
        `${method}: plan price ${price} USDC base units exceeds the confirmed maximum ${max}. ` +
          "The on-chain price may have changed — re-confirm the current price before paying.",
      );
    }
    return price;
  }

  /**
   * Submit a gateway attestation via `submit_attestation`. The feed account for
   * `(sourceId, signaturesRequired, submitter)` is created on first use.
   *
   * Per the program, the instruction takes one read-only `Node` account per signer bit
   * (ascending bit order, resolved from the registry snapshot the round was signed
   * against) and a {@link CoalitionKey} argument. Unless `opts.coalitionKey` is given the
   * SDK fetches those `Node` accounts and sums their secp256k1 keys client-side
   * (`computeCoalitionKey`); the program only checks the key, so a wrong one fails the
   * transaction and nothing else.
   *
   * `opts.rawValue` is for values longer than 32 bytes: the signed `payload.value` must be
   * `keccak256(rawValue)`; {@link buildSubmitAttestationArgs} validates that before send.
   */
  async submitAttestation(
    attestation: Attestation,
    opts?: SubmitAttestationOptions,
  ): Promise<SubmitResult> {
    const { args, accounts, remaining, feed } = await this.prepareSubmit(attestation, opts);
    const preInstructions = [
      setComputeUnitLimit(opts?.computeUnitLimit ?? estimateSubmitComputeUnits(remaining.length)),
    ];
    const price = await this.resolvePriorityFee(opts?.priorityFeeMicroLamports, feed);
    if (price > 0) preInstructions.push(setComputeUnitPrice(price));

    const signature = await this.methods
      .submitAttestation(args)
      .accountsPartial(accounts)
      .remainingAccounts(remaining)
      .preInstructions(preInstructions)
      .rpc();
    return { signature, feed };
  }

  /**
   * Submit several attestations of one feed in one transaction.
   *
   * Each becomes its own `submit_attestation` instruction, in timestamp order, and instructions run
   * in the order they are listed: all of them are applied, oldest first, whatever order other
   * transactions reach the leader in. That is what separate submits cannot promise. Transactions sent
   * milliseconds apart for one feed are overtaken by a newer one often enough (about a third at 250 ms
   * spacing in a devnet run) that the older one fails with `FeedNotNewer`; a batch makes the spacing
   * between transactions several times longer and spends one fee and one signature for them all.
   *
   * The transaction is atomic: if one instruction fails (typically because a newer attestation
   * of the feed landed first, so every instruction is stale) none of them applies. Batch only what
   * is due together, and keep batches of one feed in the order they were made.
   *
   * All attestations must be for one feed (the same `sourceId` and `signaturesRequired`) with
   * distinct timestamps. They need not share a registry version or a signer set. Values longer than
   * 32 bytes (`rawValue`) are not supported here: submit those with {@link submitAttestation}.
   *
   * @throws {BatchTooLargeError} when they do not fit in one transaction (about three do with
   *   three signers; see {@link maxAttestationsPerTransaction}). Nothing is sent.
   */
  async submitAttestations(
    attestations: Attestation[],
    opts?: SubmitAttestationsOptions,
  ): Promise<SubmitAttestationsResult> {
    if (attestations.length === 0) {
      throw new RangeError("submitAttestations needs at least one attestation");
    }
    const sorted = [...attestations].sort((a, b) => a.payload.timestamp - b.payload.timestamp);
    const feedKey = (a: Attestation) =>
      `${bytesToHex(toFixedBytes(a.payload.sourceId, 32, "sourceId"))}:${a.payload.signaturesRequired}`;
    const first = feedKey(sorted[0]!);
    sorted.forEach((a, i) => {
      if (feedKey(a) !== first) {
        throw new RangeError(
          "submitAttestations: every attestation must be for the same feed (sourceId and signaturesRequired)",
        );
      }
      if (i > 0 && a.payload.timestamp === sorted[i - 1]!.payload.timestamp) {
        throw new RangeError(
          `submitAttestations: two attestations have timestamp ${a.payload.timestamp}; the second would be refused as not newer`,
        );
      }
    });
    if (sorted.length === 1) return { ...(await this.submitAttestation(sorted[0]!, opts)), count: 1 };

    const prepared = await Promise.all(sorted.map((a) => this.prepareSubmit(a)));
    const instructions: web3.TransactionInstruction[] = await Promise.all(
      prepared.map((p) =>
        this.methods
          .submitAttestation(p.args)
          .accountsPartial(p.accounts)
          .remainingAccounts(p.remaining)
          .instruction(),
      ),
    );
    const feed = prepared[0]!.feed;
    const budget = [
      setComputeUnitLimit(
        opts?.computeUnitLimit ?? estimateSubmitBatchComputeUnits(prepared.map((p) => p.remaining.length)),
      ),
    ];
    const price = await this.resolvePriorityFee(opts?.priorityFeeMicroLamports, feed);
    if (price > 0) budget.push(setComputeUnitPrice(price));

    const payer = this.provider.wallet.publicKey;
    const size = transactionSize(payer, [...budget, ...instructions]);
    if (size > web3.PACKET_DATA_SIZE) {
      let fits = 0;
      while (
        fits < instructions.length &&
        transactionSize(payer, [...budget, ...instructions.slice(0, fits + 1)]) <= web3.PACKET_DATA_SIZE
      ) {
        fits++;
      }
      throw new BatchTooLargeError(fits, size, web3.PACKET_DATA_SIZE, instructions.length);
    }
    const signature = await this.provider.sendAndConfirm(new web3.Transaction().add(...budget, ...instructions));
    return { signature, feed, count: instructions.length };
  }

  /**
   * Everything one `submit_attestation` instruction needs: the arguments, the named accounts, the
   * signer `Node` accounts (ascending bit order) and the feed address.
   */
  private async prepareSubmit(
    attestation: Attestation,
    opts?: { coalitionKey?: CoalitionKey; rawValue?: Uint8Array },
  ) {
    const { payload, signature: schnorr } = attestation;
    const sourceId = toFixedBytes(payload.sourceId, 32, "sourceId");
    const submitter = this.wallet;
    const registry = await this.fetchRegistryCached(payload.registryVersion);
    const remaining = resolveRemainingAccounts(schnorr.signersBitmap, registry);
    assertSignerCount(remaining.length, payload.signaturesRequired, registry);
    const coalitionKey =
      opts?.coalitionKey ??
      (await this.computeSignerCoalitionKey(remaining, registry, schnorr.signersBitmap));
    const feed = feedPda(sourceId, payload.signaturesRequired, submitter, this.programId);
    return {
      args: buildSubmitAttestationArgs(attestation, coalitionKey, opts?.rawValue),
      accounts: {
        submitter,
        registry: registryPda(payload.registryVersion, this.programId),
        feed,
        protocolConfig: protocolConfigPda(this.programId),
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
      },
      remaining,
      feed,
    };
  }

  /** The registry for `version`, reused for {@link REGISTRY_CACHE_MS}. */
  private fetchRegistryCached(version: number): Promise<RegistryView> {
    const now = Date.now();
    const hit = this.registryCache.get(version);
    if (hit && now - hit.at < REGISTRY_CACHE_MS) return hit.value;
    const value = this.fetchRegistry(version);
    this.registryCache.set(version, { at: now, value });
    value.catch(() => {
      if (this.registryCache.get(version)?.value === value) this.registryCache.delete(version);
    });
    return value;
  }

  private async resolvePriorityFee(
    option: number | "auto" | undefined,
    feed: SolanaAddress,
  ): Promise<number> {
    if (option === undefined) return 0;
    if (option !== "auto") {
      if (!Number.isFinite(option) || option < 0) {
        throw new Error("priorityFeeMicroLamports must be a non-negative number or \"auto\"");
      }
      return Math.floor(option);
    }
    const now = Date.now();
    if (!this.priorityFeeCache || now - this.priorityFeeCache.at >= PRIORITY_FEE_CACHE_MS) {
      const value = (async () => {
        try {
          const recent = await this.provider.connection.getRecentPrioritizationFees({
            lockedWritableAccounts: [new web3.PublicKey(feed)],
          });
          const fees = recent.map((r) => r.prioritizationFee).sort((a, b) => a - b);
          if (fees.length === 0) return 0;
          const fee = fees[Math.min(fees.length - 1, Math.floor(fees.length * AUTO_FEE_PERCENTILE))]!;
          return Math.min(fee, AUTO_FEE_CAP_MICRO_LAMPORTS);
        } catch {
          return 0; // an unreadable fee market must not stop a submit
        }
      })();
      this.priorityFeeCache = { at: now, value };
    }
    return this.priorityFeeCache.value;
  }

  /** Sum of the signers' keys, read from their on-chain `Node` accounts (one batched fetch). */
  private computeSignerCoalitionKey(
    remaining: SolanaAccountMeta[],
    registry: RegistryView,
    signersBitmap: string,
  ): Promise<CoalitionKey> {
    // A node's key never changes, so the sum for one (registry, signer set) is reusable, and
    // each Node account is read at most once however many signer sets include it. The promise is
    // cached, so concurrent submits of one signer set share a single read.
    const setKey = `${registry.version}:${signersBitmap}`;
    const known = this.coalitionCache.get(setKey);
    if (known) return known;
    if (this.coalitionCache.size >= KEY_CACHE_LIMIT) this.coalitionCache.clear();
    const pending = this.sumSignerKeys(remaining, registry);
    this.coalitionCache.set(setKey, pending);
    pending.catch(() => {
      if (this.coalitionCache.get(setKey) === pending) this.coalitionCache.delete(setKey);
    });
    return pending;
  }

  private async sumSignerKeys(
    remaining: SolanaAccountMeta[],
    registry: RegistryView,
  ): Promise<CoalitionKey> {
    const addresses = remaining.map((meta) => meta.pubkey);
    const missing = addresses.filter((a) => !this.nodeKeyCache.has(a.toBase58()));
    if (missing.length > 0) {
      const accounts: Array<NodeAccount | null> = await this.accounts.node.fetchMultiple(missing);
      if (this.nodeKeyCache.size + missing.length > KEY_CACHE_LIMIT) this.nodeKeyCache.clear();
      accounts.forEach((account, i) => {
        if (!account) {
          throw new Error(
            `Node account ${missing[i]!.toBase58()} (registry ${registry.version}) does not exist`,
          );
        }
        this.nodeKeyCache.set(missing[i]!.toBase58(), {
          x: nodeCoordinate(account, "secp256k1PubkeyX", "secp256k1_pubkey_x"),
          y: nodeCoordinate(account, "secp256k1PubkeyY", "secp256k1_pubkey_y"),
        });
      });
    }
    return computeCoalitionKey(addresses.map((a) => this.nodeKeyCache.get(a.toBase58())!));
  }

  /**
   * Read the feed written by `submitter` (default: this wallet) for
   * `(sourceId, signaturesRequired)`, or `null` before its first submit.
   */
  async readFeed(
    sourceId: string,
    signaturesRequired: number,
    submitter: SolanaAddress = this.wallet,
  ): Promise<FeedAccount | null> {
    const feed = feedPda(
      toFixedBytes(sourceId, 32, "sourceId"),
      signaturesRequired,
      submitter,
      this.programId,
    );
    return (await this.accounts.feed.fetchNullable(feed)) as FeedAccount | null;
  }

  /**
   * Authenticate gateway-provided private API encryption keys against the
   * on-chain Node accounts of the round's registry snapshot (`registry.nodes[index]`).
   */
  async verifyNodeKeysForPrivateApi(args: NodeKeyVerifierArgs): Promise<void> {
    const registry = await this.fetchRegistry(args.registryVersion);
    const selectedNodes = selectedNodesForVerifier(args);

    await Promise.all(
      selectedNodes.map(async (node) => {
        const nodeAddress = registry.nodes[node.index];
        if (node.index >= registry.nodeCount || nodeAddress === undefined) {
          throw new Error(
            `Gateway selected node ${node.index} is outside registry ${registry.version} node_count ${registry.nodeCount}`,
          );
        }
        const account = await this.fetchNodeAccount(nodeAddress, node.index);
        const onChainKey = secp256k1PublicKeyFromCoordinates(
          nodeCoordinate(account, "secp256k1PubkeyX", "secp256k1_pubkey_x"),
          nodeCoordinate(account, "secp256k1PubkeyY", "secp256k1_pubkey_y"),
          `Node(${nodeAddress}) secp256k1 public key`,
        );
        const gatewayKey = normalizeSecp256k1PublicKeyHex(
          node.signingKey,
          `Gateway selected node ${node.index} signingKey`,
        );
        if (gatewayKey !== onChainKey) {
          throw new Error(
            `Gateway selected node ${node.index} signingKey does not match on-chain Node(${nodeAddress})`,
          );
        }
      }),
    );
  }

  private decodePlan(account: {
    planType: Record<string, unknown>;
    subscriptionPrice: { toString(): string };
    maxSigners: number;
    maxDelegates: number;
    maxRounds: { toString(): string };
    privateApiEnabled: boolean;
    isActive: boolean;
  }): PlanInfo {
    return {
      planType: planIdFromVariant(account.planType) as unknown as PlanType,
      subscriptionPrice: BigInt(account.subscriptionPrice.toString()),
      maxSigners: account.maxSigners,
      maxDelegates: account.maxDelegates,
      maxRounds: BigInt(account.maxRounds.toString()),
      privateApiEnabled: account.privateApiEnabled,
      isActive: account.isActive,
    };
  }

  private async fetchRegistryState(): Promise<RegistryStateView> {
    const state = await this.accounts.registryState.fetch(registryStatePda(this.programId));
    return {
      currentVersion: state.currentVersion,
      nextVersion: state.nextVersion,
    };
  }

  private async fetchRegistry(version: number): Promise<RegistryView> {
    const registry = await this.accounts.registry.fetch(registryPda(version, this.programId));
    const nodeCount: number = registry.nodeCount;
    const nodes = (registry.nodes as Array<Uint8Array | number[]>)
      .slice(0, nodeCount)
      .map((entry) => addressFromBytes(Uint8Array.from(entry)));
    return {
      version: registry.version,
      nodeCount,
      redundancyBuffer: registry.redundancyBuffer,
      nodes,
      graceActiveUntil: BigInt(registry.graceActiveUntil.toString()),
      activeFrom: BigInt(registry.activeFrom.toString()),
    };
  }

  private async fetchNodeAccount(
    nodeAddress: Address,
    selectedNodeIndex: number,
  ): Promise<NodeAccount> {
    try {
      return await this.accounts.node.fetch(nodeAddress);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch on-chain Node(${nodeAddress}) for selected node ${selectedNodeIndex}: ${detail}`,
      );
    }
  }

  /** `usdc_mint` from `ProtocolConfig`; the treasury is its ATA owned by the config PDA. */
  private async fetchProtocolTokens(): Promise<{ usdcMint: Address; treasury: Address }> {
    const protocolConfig = protocolConfigPda(this.programId);
    const config = await this.accounts.protocolConfig.fetch(protocolConfig);
    const usdcMint = toSolanaAddress(config.usdcMint);
    return {
      usdcMint,
      treasury: getAssociatedTokenAddressSync(usdcMint, protocolConfig),
    };
  }
}

/**
 * Build the Anchor `SubmitAttestationArgs` for a gateway result: `{ attestation: { payload,
 * signature }, rawValue, coalitionKey }`. `coalitionKey` is the affine sum of the signers'
 * keys (see `computeCoalitionKey`).
 */
export function buildSubmitAttestationArgs(
  attestation: Attestation,
  coalitionKey: CoalitionKey,
  rawValue?: Uint8Array | null,
): SubmitAttestationArgs {
  const { payload, signature } = attestation;
  const value = toFixedBytes(payload.value, 32, "payload.value");
  if (rawValue && rawValue.length > 256) {
    throw new RangeError(`rawValue must be at most 256 bytes, got ${rawValue.length}`);
  }
  if (rawValue && bytesToHex(keccak_256(rawValue)) !== bytesToHex(value)) {
    throw new Error("rawValue keccak256 digest does not match attestation.payload.value");
  }
  return {
    attestation: {
      payload: {
        value: Array.from(toFixedBytes(payload.value, 32, "payload.value")),
        sourceId: Array.from(toFixedBytes(payload.sourceId, 32, "sourceId")),
        registryVersion: payload.registryVersion,
        signaturesRequired: payload.signaturesRequired,
        timestamp: new BN(payload.timestamp),
      },
      signature: {
        aggSigS: Array.from(toFixedBytes(signature.s, 32, "signature.s")),
        commitment: Array.from(toFixedBytes(signature.commitmentAddr, 20, "signature.commitmentAddr")),
        signersBitmap: Array.from(toFixedBytes(signature.signersBitmap, 32, "signature.signersBitmap")),
      },
    },
    rawValue: rawValue ? toAnchorBytes(rawValue) : null,
    coalitionKey: {
      x: Array.from(toFixedBytes(coalitionKey.x, 32, "coalitionKey.x")),
      y: Array.from(toFixedBytes(coalitionKey.y, 32, "coalitionKey.y")),
    },
  };
}

/**
 * Mirror the program's signer-count bounds (`verify_attestation_core`):
 * `signaturesRequired <= popcount <= signaturesRequired + redundancyBuffer`.
 */
function assertSignerCount(
  signerCount: number,
  signaturesRequired: number,
  registry: RegistryView,
): void {
  if (signerCount < signaturesRequired) {
    throw new Error(
      `QuorumBelowThreshold: ${signerCount} signers < signaturesRequired ${signaturesRequired}`,
    );
  }
  if (signerCount > signaturesRequired + registry.redundancyBuffer) {
    throw new Error(
      `CreditedExceedsSelection: ${signerCount} signers > signaturesRequired ${signaturesRequired} + redundancy buffer ${registry.redundancyBuffer} of registry ${registry.version}`,
    );
  }
}

/** Browser-safe byte array accepted by Anchor's Buffer-oriented `bytes` Borsh layout. */
function toAnchorBytes(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes) as Uint8Array & {
    copy(target: Uint8Array, targetStart?: number): number;
  };
  out.copy = (target, targetStart = 0) => {
    target.set(out, targetStart);
    return out.length;
  };
  return out;
}

/** Normalize a confirmed USDC amount (base units) to `bigint`, rejecting non-integers. */
function toUsdcBaseUnits(amount: bigint | number | BN, label: string): bigint {
  if (typeof amount === "bigint") {
    if (amount < 0n) throw new Error(`${label} must be non-negative, got ${amount}`);
    return amount;
  }
  if (typeof amount === "number") {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error(`${label} must be a non-negative integer of USDC base units, got ${amount}`);
    }
    return BigInt(amount);
  }
  return BigInt(amount.toString());
}

function nodeCoordinate(
  account: NodeAccount,
  camelCaseField: "secp256k1PubkeyX" | "secp256k1PubkeyY",
  snakeCaseField: "secp256k1_pubkey_x" | "secp256k1_pubkey_y",
): Uint8Array {
  const value = account[camelCaseField] ?? account[snakeCaseField];
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new Error(`Node account is missing ${camelCaseField}`);
  }
  return toFixedBytes(Uint8Array.from(value), 32, `Node.${camelCaseField}`);
}

function selectedNodesForVerifier(args: NodeKeyVerifierArgs): Node[] {
  if (args.nodeIndexes.length === 0) {
    throw new Error("Private API node-key verification requires at least one selected index");
  }
  if (args.nodes.length !== args.nodeIndexes.length) {
    throw new Error(
      `Private API node-key verification expected ${args.nodeIndexes.length} selected nodes, got ${args.nodes.length}`,
    );
  }

  const expected = new Set<number>();
  for (const index of args.nodeIndexes) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Private API selected index must be a non-negative integer: ${index}`);
    }
    if (expected.has(index)) {
      throw new Error(`Private API selected index is duplicated: ${index}`);
    }
    expected.add(index);
  }

  const byIndex = new Map<number, Node>();
  for (const node of args.nodes) {
    if (!Number.isInteger(node.index) || node.index < 0) {
      throw new Error(
        `Private API selected node index must be a non-negative integer: ${node.index}`,
      );
    }
    if (!expected.has(node.index)) {
      throw new Error(`Private API selected node ${node.index} was not requested`);
    }
    if (byIndex.has(node.index)) {
      throw new Error(`Private API selected node index is duplicated: ${node.index}`);
    }
    byIndex.set(node.index, node);
  }

  return args.nodeIndexes.map((index) => {
    const node = byIndex.get(index);
    if (!node) {
      throw new Error(`Private API selected node is missing for index: ${index}`);
    }
    return node;
  });
}
