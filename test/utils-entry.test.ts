/**
 * Loads the built `index` and `utils` entry points in a plain Node process, the way a consumer
 * does. Vitest resolves CommonJS named exports more loosely than Node's ESM loader, so an
 * in-process import would not catch the `@anchor-lang/core` 1.2.2 regression (`Wallet` exported
 * through a getter that Node does not see as a named export). The installed Anchor version is the
 * one this checks against: the lockfile pins 1.2.2.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeypair } from "../src/solana/kit.js";

const outDir = resolve(__dirname, "../node_modules/.cache/sdk-esm-smoke");
let keyDir: string;

beforeAll(async () => {
  await build({
    config: false,
    entry: {
      index: resolve(__dirname, "../src/index.ts"),
      utils: resolve(__dirname, "../src/utils.ts"),
    },
    format: ["esm"],
    outDir,
    clean: true,
    splitting: true,
    target: "es2022",
    dts: false,
    silent: true,
    external: ["@anchor-lang/core", "@solana/kit", "bn.js"],
  });
  keyDir = mkdtempSync(join(tmpdir(), "molpha-sdk-smoke-"));
}, 60_000);

afterAll(() => {
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

const runNode = (script: string): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: outDir,
    encoding: "utf-8",
  });

describe("@molpha/sdk/utils under Node's ESM loader", () => {
  it("loads a keypair file and constructs MolphaSDK", () => {
    const keypair = generateKeypair();
    const keyPath = join(keyDir, "id.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(keypair.secretKey)));

    const out = runNode(`
      import { createRequire } from "node:module";
      import { web3 } from "@anchor-lang/core";
      import { walletFromKeypairFile, Wallet } from "./utils.js";
      import { MolphaSDK } from "./index.js";
      const wallet = walletFromKeypairFile(${JSON.stringify(keyPath)});
      const sdk = new MolphaSDK({
        connection: new web3.Connection("http://127.0.0.1:8899"),
        wallet,
      });
      const anchor = createRequire(import.meta.url)("@anchor-lang/core/package.json").version;
      console.log(JSON.stringify({
        anchor,
        publicKey: wallet.publicKey.toBase58(),
        sdk: sdk instanceof MolphaSDK,
        local: typeof Wallet.local,
      }));
    `);
    const result = JSON.parse(out.trim().split("\n").pop()!) as {
      anchor: string;
      publicKey: string;
      sdk: boolean;
      local: string;
    };
    expect(result.publicKey).toBe(keypair.publicKey.toBase58());
    expect(result.sdk).toBe(true);
    expect(result.local).toBe("function");
    expect(result.anchor).toMatch(/^1\./);
  });
});
