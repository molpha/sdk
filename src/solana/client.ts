/**
 * `MolphaSolanaClient` — consumer on-chain surface only (subscribe, extend,
 * submitAttestation, readFeed/readPlan/readSubscription/readRegistry,
 * getRegistrySelectionConfig, verifyNodeKeysForPrivateApi). Built from an Anchor
 * `Program` over the vendored IDL (program `3d01170`, "Epoch settlements").
 */
import {
  AnchorProvider,
  Program,
  web3,
  type Idl,
  type Wallet,
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
  DataUpdateResult,
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

/** Matches the program CLI default; `submit_attestation` verifies the aggregate on-chain. */
const DEFAULT_COMPUTE_UNIT_LIMIT = 1_400_000;
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
 * On-chain `Subscription`. The program no longer tracks usage: `used_rounds`,
 * `prepaid_usdc` and the locked `price` were removed (round quota is counted by the
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
  /** u64 unix seconds. */
  canonicalTimestamp: BN;
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
      canonicalTimestamp: BN;
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
  computeUnitLimit?: number;
  /**
   * Optional value preimage (maximum 256 bytes). Its keccak256 digest must equal
   * `result.valuePacked`; the program stores that digest with `valueKind.hash`.
   */
  rawValue?: Uint8Array;
}

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
   * `opts.rawValue` is for values longer than 32 bytes: the signed `valuePacked` must be
   * `keccak256(rawValue)`; {@link buildSubmitAttestationArgs} validates that before send.
   */
  async submitAttestation(
    result: DataUpdateResult,
    opts?: { computeUnitLimit?: number; coalitionKey?: CoalitionKey; rawValue?: Uint8Array },
  ): Promise<SubmitResult> {
    const sourceId = toFixedBytes(result.sourceId, 32, "sourceId");
    const submitter = this.wallet;
    const registry = await this.fetchRegistry(result.registryVersion);
    const remaining = resolveRemainingAccounts(result.signersBitmap, registry);
    assertSignerCount(remaining.length, result.signaturesRequired, registry);
    const coalitionKey =
      opts?.coalitionKey ?? (await this.computeSignerCoalitionKey(remaining, registry));
    const feed = feedPda(sourceId, result.signaturesRequired, submitter, this.programId);
    const cuIx = setComputeUnitLimit(opts?.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT);

    const signature = await this.methods
      .submitAttestation(
        buildSubmitAttestationArgs(result, coalitionKey, opts?.rawValue),
      )
      .accountsPartial({
        submitter,
        registry: registryPda(result.registryVersion, this.programId),
        feed,
        protocolConfig: protocolConfigPda(this.programId),
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
      })
      .remainingAccounts(remaining)
      .preInstructions([cuIx])
      .rpc();
    return { signature, feed };
  }

  /** Sum of the signers' keys, read from their on-chain `Node` accounts (one batched fetch). */
  private async computeSignerCoalitionKey(
    remaining: SolanaAccountMeta[],
    registry: RegistryView,
  ): Promise<CoalitionKey> {
    const accounts: Array<NodeAccount | null> = await this.accounts.node.fetchMultiple(
      remaining.map((meta) => meta.pubkey),
    );
    const keys = accounts.map((account, i) => {
      if (!account) {
        throw new Error(
          `Node account ${remaining[i]!.pubkey.toBase58()} (registry ${registry.version}) does not exist`,
        );
      }
      return {
        x: nodeCoordinate(account, "secp256k1PubkeyX", "secp256k1_pubkey_x"),
        y: nodeCoordinate(account, "secp256k1PubkeyY", "secp256k1_pubkey_y"),
      };
    });
    return computeCoalitionKey(keys);
  }

  /** @deprecated Renamed to {@link submitAttestation}. */
  submitDataUpdate(
    result: DataUpdateResult,
    opts?: { computeUnitLimit?: number; coalitionKey?: CoalitionKey; rawValue?: Uint8Array },
  ): Promise<SubmitResult> {
    return this.submitAttestation(result, opts);
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
  result: DataUpdateResult,
  coalitionKey: CoalitionKey,
  rawValue?: Uint8Array | null,
): SubmitAttestationArgs {
  const value = toFixedBytes(result.valuePacked, 32, "valuePacked");
  if (rawValue && rawValue.length > 256) {
    throw new RangeError(`rawValue must be at most 256 bytes, got ${rawValue.length}`);
  }
  if (rawValue && bytesToHex(keccak_256(rawValue)) !== bytesToHex(value)) {
    throw new Error("rawValue keccak256 digest does not match result.valuePacked");
  }
  return {
    attestation: {
      payload: {
        value: Array.from(toFixedBytes(result.valuePacked, 32, "valuePacked")),
        sourceId: Array.from(toFixedBytes(result.sourceId, 32, "sourceId")),
        registryVersion: result.registryVersion,
        signaturesRequired: result.signaturesRequired,
        canonicalTimestamp: new BN(result.timestamp),
      },
      signature: {
        aggSigS: Array.from(toFixedBytes(result.s, 32, "s")),
        commitment: Array.from(toFixedBytes(result.commitmentAddr, 20, "commitmentAddr")),
        signersBitmap: Array.from(toFixedBytes(result.signersBitmap, 32, "signersBitmap")),
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
  if (args.selectedIndexes.length === 0) {
    throw new Error("Private API node-key verification requires at least one selected index");
  }
  if (args.selectedNodes.length !== args.selectedIndexes.length) {
    throw new Error(
      `Private API node-key verification expected ${args.selectedIndexes.length} selected nodes, got ${args.selectedNodes.length}`,
    );
  }

  const expected = new Set<number>();
  for (const index of args.selectedIndexes) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Private API selected index must be a non-negative integer: ${index}`);
    }
    if (expected.has(index)) {
      throw new Error(`Private API selected index is duplicated: ${index}`);
    }
    expected.add(index);
  }

  const byIndex = new Map<number, Node>();
  for (const node of args.selectedNodes) {
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

  return args.selectedIndexes.map((index) => {
    const node = byIndex.get(index);
    if (!node) {
      throw new Error(`Private API selected node is missing for index: ${index}`);
    }
    return node;
  });
}
