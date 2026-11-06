/**
 * Raw `Registry` account bytes in the program's layout, for tests that stub `getAccountInfo`.
 *
 * Layout (`programs/molpha/src/state/registry.rs`): the 8-byte Anchor discriminator, then
 * `grace_active_until` i64, `active_from` i64, `version` u32, `node_count` u8, `provider_count` u8,
 * `redundancy_buffer` u8, `bump` u8 (32 bytes in all), then one 96-byte record per slot (member
 * account, key `x`, key `y`): the node slots, then the provider slots. A hole is all zero.
 * `provider_accounts.json` holds real bytes built by the program; this builds arbitrary ones.
 */
import { web3 } from "@anchor-lang/core";
import { MOLPHA_IDL } from "../../idl/index.js";
import { hexToBytes } from "../../src/core/encoding.js";

export interface RegistryRecord {
  /** Member account (a `Node` or a `Provider` PDA), 32 bytes. */
  account: Uint8Array;
  /** Signing key, 32-byte big-endian hex. */
  x: string;
  y: string;
}

export const REGISTRY_DISCRIMINATOR = Uint8Array.from(
  MOLPHA_IDL.accounts!.find((account) => account.name === "Registry")!.discriminator,
);

export function registryAccountBytes(opts: {
  version: number;
  redundancyBuffer: number;
  nodes: Array<RegistryRecord | null>;
  providers?: Array<RegistryRecord | null>;
  activeFrom?: bigint;
  graceActiveUntil?: bigint;
}): Buffer {
  const providers = opts.providers ?? [];
  const records = [...opts.nodes, ...providers];
  const data = Buffer.alloc(32 + records.length * 96);
  data.set(REGISTRY_DISCRIMINATOR, 0);
  data.writeBigInt64LE(opts.graceActiveUntil ?? 0n, 8);
  data.writeBigInt64LE(opts.activeFrom ?? 1_700_000_000n, 16);
  data.writeUInt32LE(opts.version, 24);
  data[28] = opts.nodes.length;
  data[29] = providers.length;
  data[30] = opts.redundancyBuffer;
  data[31] = 255;
  records.forEach((record, index) => {
    if (record === null) return;
    const at = 32 + index * 96;
    data.set(record.account, at);
    data.set(hexToBytes(record.x), at + 32);
    data.set(hexToBytes(record.y), at + 64);
  });
  return data;
}

/** An `AccountInfo` for `data` owned by `owner`, as `Connection.getAccountInfo` returns it. */
export function accountInfo(data: Buffer, owner: string): web3.AccountInfo<Buffer> {
  return {
    data,
    owner: new web3.PublicKey(owner),
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}
