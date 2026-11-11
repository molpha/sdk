import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Browser-safe entry points: `@noble` only, no Anchor, bn.js or Node built-ins.
    core: "src/core/index.ts",
    evm: "src/evm/index.ts",
    starknet: "src/starknet/index.ts",
    data: "src/data/index.ts",
    utils: "src/utils.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: true,
  target: "es2022",
  // Solana surface is an optional peer dependency; never bundle it.
  external: ["@anchor-lang/core", "@solana/kit", "bn.js"],
});
