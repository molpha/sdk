/**
 * `decodeRegistryAccount` and `resolveSignerKeys` against real account bytes built by the program's
 * own LiteSVM harness (`molpha-solana-program/molpha-tests/tests/provider_account_fixture.rs`, copied
 * verbatim to `fixtures/provider_accounts.json`; the node client and the gateway test their decoders
 * against the same file).
 *
 * The scenario: three nodes; provider A at slot 1; provider B at slot 2, then ejected; provider C
 * registered after that, taking the freed slot 2. Provider slot 0 is reserved and stays a hole.
 */
import { describe, expect, it } from "vitest";
import { computeCoalitionKey } from "../src/core/coalition.js";
import { bytesToHex, hexToBytes } from "../src/core/encoding.js";
import { NODE_SLOTS } from "../src/core/selection.js";
import {
  decodeRegistryAccount,
  liveSlots,
  registrySigner,
  resolveSignerKeys,
} from "../src/solana/accounts.js";
import { registryPda } from "../src/solana/pdas.js";
import FIXTURE from "./fixtures/provider_accounts.json" with { type: "json" };

const hex = (bytes: Uint8Array | null | undefined) => (bytes ? bytesToHex(bytes) : null);
const bitmap = (bits: number[]) => {
  const out = new Uint8Array(32);
  for (const bit of bits) out[31 - (bit >> 3)]! |= 1 << (bit & 7);
  return bytesToHex(out);
};
const provider = (name: string) => FIXTURE.providers.find((p) => p.name === name)!;
const decoded = (version: number) => {
  const fixture = FIXTURE.registries.find((r) => r.version === version)!;
  return decodeRegistryAccount(hexToBytes(fixture.data));
};

describe("registry accounts the program built", () => {
  it("lives at the registry PDA of its version", () => {
    for (const registry of FIXTURE.registries) {
      expect(registryPda(registry.version, FIXTURE.program_id)).toBe(registry.address);
    }
  });

  it("decodes the node table: the Node accounts and the keys they sign with", () => {
    for (const { version } of FIXTURE.registries) {
      const registry = decoded(version);
      expect(registry.version).toBe(version);
      expect(registry.nodeCount).toBe(FIXTURE.nodes.length);
      for (const node of FIXTURE.nodes) {
        expect(registry.nodes[node.index]).toBe(node.address);
        expect(hex(registry.nodeKeys[node.index]?.x)).toBe(node.x);
        expect(hex(registry.nodeKeys[node.index]?.y)).toBe(node.y);
      }
      expect(liveSlots(registry)).toEqual([0, 1, 2]);
    }
  });

  it("decodes the provider table with its reserved slot, ejection and reuse", () => {
    const check = (version: number, slots: Array<string | null>) => {
      const registry = decoded(version);
      expect(registry.providerCount).toBe(slots.length);
      slots.forEach((name, slot) => {
        if (name === null) {
          expect(registry.providers[slot]).toBeNull();
          expect(registry.providerKeys[slot]).toBeNull();
          return;
        }
        const p = provider(name);
        expect(p.slot).toBe(slot);
        expect(registry.providers[slot]).toBe(p.address);
        expect(registrySigner(registry, NODE_SLOTS + slot)).toBe(p.address);
        expect(hex(registry.providerKeys[slot]?.x)).toBe(p.x);
        expect(hex(registry.providerKeys[slot]?.y)).toBe(p.y);
      });
    };
    check(5, [null, "A", "B"]);
    // B's ejection frees slot 2, which is trailing and trimmed.
    check(6, [null, "A"]);
    // C takes the freed slot: the registry, not the Provider account, says who holds it.
    check(7, [null, "A", "C"]);
  });

  it("sums a provider round's coalition key from the record keys", () => {
    const keyOf = (p: { x: string; y: string }) => ({ x: p.x, y: p.y });
    const v5 = decoded(5);
    const keys = resolveSignerKeys(bitmap([0, 2, NODE_SLOTS + 2]), v5);
    expect(computeCoalitionKey(keys)).toEqual(
      computeCoalitionKey([FIXTURE.nodes[0]!, FIXTURE.nodes[2]!, provider("B")].map(keyOf)),
    );
    // The same bit names C in version 7, and nobody in version 6.
    const v7 = resolveSignerKeys(bitmap([0, 2, NODE_SLOTS + 2]), decoded(7));
    expect(computeCoalitionKey(v7)).toEqual(
      computeCoalitionKey([FIXTURE.nodes[0]!, FIXTURE.nodes[2]!, provider("C")].map(keyOf)),
    );
    expect(() => resolveSignerKeys(bitmap([0, 1, NODE_SLOTS + 2]), decoded(6))).toThrow(
      /bit 66 names no live member of registry 6/,
    );
    expect(() => resolveSignerKeys(bitmap([0, 1, NODE_SLOTS]), v5)).toThrow(/bit 64/);
  });
});
