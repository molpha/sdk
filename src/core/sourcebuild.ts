/**
 * Building and reading sources: defaults, builders, value rendering and the exact-mode lint.
 *
 * A source on the wire has every key present and every number a string, which is verbose to write
 * by hand. {@link defineSource} takes the short form (omitted optionals, JS numbers for integers),
 * fills it in, and returns the validated {@link ParsedSource}; the builders below make the common
 * pieces. None of this changes what a source means: the output of `defineSource` is the same
 * document one would write in full, and its ID is the hash of its canonical form.
 *
 * This file is kept byte-identical in `@molpha/gateway-sdk` and `@molpha/sdk`.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "./encoding.js";
import {
  parseSource,
  type Expr,
  type OutputType,
  type ParsedSource,
  type SourceDoc,
} from "./source.js";

type Num = number | bigint | string;

/** A JS integer or a string, as the canonical decimal string the format wants. */
function numStr(x: Num | null | undefined): string | null | undefined {
  if (x === undefined || x === null) return x as null | undefined;
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`);
    return String(x);
  }
  return x;
}

// ---------------------------------------------------------------------------------------------
// Expression builders
// ---------------------------------------------------------------------------------------------

export type Round = "halfEven" | "down" | "up" | "halfUp";

export const ref = (name: string): Expr => ({ ref: name });
/** A decimal constant, e.g. `cst("0.5")`. */
export const cst = (x: Num): Expr => ({ const: numStr(x) as string });
export const strLit = (s: string): Expr => ({ str: s });
export const bytesLit = (hex: string): Expr => ({ bytes: hex });
export const boolLit = (b: boolean): Expr => ({ bool: b });

const op = (
  name: string,
  args: Expr[],
  params: Record<string, unknown> = {},
): Expr => ({ op: name, args, ...params });

/** Parse a string into a decimal; the mode says which spelling is acceptable. */
export const num = (a: Expr, mode: "dec" | "hex" | "sci" = "dec"): Expr =>
  op("num", [a], { mode });
export const int = (a: Expr): Expr => op("int", [a]);
export const str = (a: Expr): Expr => op("str", [a]);
export const hexBytes = (a: Expr): Expr => op("hexBytes", [a]);
export const add = (a: Expr, b: Expr): Expr => op("add", [a, b]);
export const sub = (a: Expr, b: Expr): Expr => op("sub", [a, b]);
/** Multiplies; scales add and must stay within 36, so `rescale` an operand first if needed. */
export const mul = (a: Expr, b: Expr): Expr => op("mul", [a, b]);
export const min = (a: Expr, b: Expr): Expr => op("min", [a, b]);
export const max = (a: Expr, b: Expr): Expr => op("max", [a, b]);
export const neg = (a: Expr): Expr => op("neg", [a]);
export const abs = (a: Expr): Expr => op("abs", [a]);
/** `a / b` to `scale` fractional digits. */
export const div = (a: Expr, b: Expr, o: { scale: Num; round?: Round }): Expr =>
  op("div", [a, b], { scale: numStr(o.scale), round: o.round ?? "halfEven" });
export const rescale = (a: Expr, o: { scale: Num; round?: Round }): Expr =>
  op("rescale", [a], { scale: numStr(o.scale), round: o.round ?? "halfEven" });
/** Multiply by 10^n, exactly. */
export const shift = (a: Expr, n: Num): Expr =>
  op("shift", [a], { n: numStr(n) });
export const eq = (a: Expr, b: Expr): Expr => op("eq", [a, b]);
export const ne = (a: Expr, b: Expr): Expr => op("ne", [a, b]);
export const lt = (a: Expr, b: Expr): Expr => op("lt", [a, b]);
export const lte = (a: Expr, b: Expr): Expr => op("lte", [a, b]);
export const gt = (a: Expr, b: Expr): Expr => op("gt", [a, b]);
export const gte = (a: Expr, b: Expr): Expr => op("gte", [a, b]);
export const iff = (cond: Expr, a: Expr, b: Expr): Expr =>
  op("if", [cond, a, b]);
export const coalesce = (a: Expr, b: Expr): Expr => op("coalesce", [a, b]);
export const keccak256 = (a: Expr): Expr => op("keccak256", [a]);
export const concat = (...args: Expr[]): Expr => op("concat", args);
export const slice = (a: Expr, o: { off: Num; len: Num }): Expr =>
  op("slice", [a], { off: numStr(o.off), len: numStr(o.len) });
export const lower = (a: Expr): Expr => op("lower", [a]);
export const upper = (a: Expr): Expr => op("upper", [a]);

// ---------------------------------------------------------------------------------------------
// Decoders and inputs
// ---------------------------------------------------------------------------------------------

export type Decode = Record<string, unknown>;

export const rawDecode = (): Decode => ({ format: "raw" });
/** `fields` maps a name to a JSON path such as `$.data.price`. */
export const jsonDecode = (fields: Record<string, string>): Decode => ({
  format: "json",
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, path]) => [k, { path }]),
  ),
});
export const textDecode = (fields: Record<string, string>): Decode => ({
  format: "text",
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, regex]) => [k, { regex }]),
  ),
});
export const xmlDecode = (
  fields: Record<string, string>,
  namespaces: Record<string, string> = {},
): Decode => ({
  format: "xml",
  namespaces,
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, path]) => [k, { path }]),
  ),
});
export const csvDecode = (o: {
  header?: boolean;
  delimiter?: string;
  trim?: boolean;
  fields: Record<
    string,
    { col: Num; row: { index: Num } | { match: { col: Num; eq: string } } }
  >;
}): Decode => ({
  format: "csv",
  header: o.header ?? true,
  delimiter: o.delimiter ?? ",",
  trim: o.trim ?? false,
  fields: o.fields,
});
export const abiDecode = (
  types: string[],
  fields: Record<string, string>,
): Decode => ({
  format: "abi",
  types,
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, pick]) => [k, { pick }]),
  ),
});
export const feltsDecode = (
  fields: Record<
    string,
    { at: Num; view: "felt" | "u256" | "bool" | "shortString" | "i128" }
  >,
): Decode => ({ format: "felts", fields });
export const layoutDecode = (
  fields: Record<string, { offset: Num; type: string }>,
  discriminator: string | null = null,
): Decode => ({
  format: "layout",
  discriminator,
  fields,
});

export interface Finality {
  mode: "finalized" | "safe" | "confirmations";
  lagMs: Num;
  n?: Num;
}

export function httpInput(o: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: { contentType: string; text: string };
  decode: Decode;
}): Record<string, unknown> {
  return {
    kind: "http",
    read: {
      method: o.method ?? "GET",
      url: o.url,
      headers: o.headers ?? {},
      body: o.body ?? null,
    },
    decode: o.decode,
  };
}
export function evmCall(o: {
  chain: string;
  to: string;
  sig?: string;
  args?: string[];
  data?: string;
  finality: Finality;
  decode: Decode;
}): Record<string, unknown> {
  return {
    kind: "evm",
    chain: o.chain,
    finality: o.finality,
    read: { method: "call", to: o.to, sig: o.sig, args: o.args, data: o.data },
    decode: o.decode,
  };
}
export function evmStorage(o: {
  chain: string;
  address: string;
  slot: string;
  finality: Finality;
  decode: Decode;
}): Record<string, unknown> {
  return {
    kind: "evm",
    chain: o.chain,
    finality: o.finality,
    read: { method: "storage", address: o.address, slot: o.slot },
    decode: o.decode,
  };
}
export function evmBalance(o: {
  chain: string;
  address: string;
  finality: Finality;
  decode: Decode;
}): Record<string, unknown> {
  return {
    kind: "evm",
    chain: o.chain,
    finality: o.finality,
    read: { method: "balance", address: o.address },
    decode: o.decode,
  };
}
export function starknetCall(o: {
  chain: string;
  contract: string;
  selector: string;
  calldata?: string[];
  finality: Finality;
  decode: Decode;
}): Record<string, unknown> {
  return {
    kind: "starknet",
    chain: o.chain,
    finality: o.finality,
    read: {
      method: "call",
      contract: o.contract,
      selector: o.selector,
      calldata: o.calldata ?? [],
    },
    decode: o.decode,
  };
}
export function svmAccount(o: {
  chain: string;
  address: string;
  commitment?: "finalized" | "confirmed";
  maxAgeMs: Num;
  dataSlice?: { offset: Num; length: Num };
  decode: Decode;
}): Record<string, unknown> {
  return {
    kind: "svm",
    chain: o.chain,
    commitment: o.commitment ?? "finalized",
    maxAgeMs: o.maxAgeMs,
    read: {
      method: "account",
      address: o.address,
      dataSlice: o.dataSlice ?? null,
    },
    decode: o.decode,
  };
}
export function svmTokenSupply(o: {
  chain: string;
  mint: string;
  commitment?: "finalized" | "confirmed";
  maxAgeMs: Num;
}): Record<string, unknown> {
  return {
    kind: "svm",
    chain: o.chain,
    commitment: o.commitment ?? "finalized",
    maxAgeMs: o.maxAgeMs,
    read: { method: "tokenSupply", mint: o.mint },
    decode: null,
  };
}

// ---------------------------------------------------------------------------------------------
// defineSource
// ---------------------------------------------------------------------------------------------

export interface SourceInput {
  inputs: Record<string, Record<string, any>>;
  transform: Expr;
  assert?: Expr[];
  output: { type: OutputType; decimals?: Num | null };
  /** Median tolerance. Omit or `null` for exact mode. */
  aggregation?: {
    maxDeviationBps: Num;
    maxAgeMs: Num;
    mode?: "tolerance";
    rule?: "median";
  } | null;
}

const isRec = (x: unknown): x is Record<string, any> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function normExpr(e: any): any {
  if (!isRec(e)) return e;
  if ("op" in e) {
    const out: Record<string, unknown> = {
      op: e.op,
      args: (e.args ?? []).map(normExpr),
    };
    for (const [k, v] of Object.entries(e))
      if (k !== "op" && k !== "args")
        out[k] = typeof v === "number" || typeof v === "bigint" ? numStr(v) : v;
    return out;
  }
  if (
    "const" in e &&
    (typeof e.const === "number" || typeof e.const === "bigint")
  )
    return { const: numStr(e.const) };
  return e;
}

function normDecode(d: any): any {
  if (!isRec(d)) return d;
  const out: Record<string, any> = { ...d };
  switch (d.format) {
    case "xml":
      out.namespaces ??= {};
      break;
    case "layout":
      out.discriminator ??= null;
      break;
    case "csv":
      out.header ??= true;
      out.delimiter ??= ",";
      out.trim ??= false;
      break;
  }
  if (isRec(d.fields)) {
    out.fields = Object.fromEntries(
      Object.entries(d.fields).map(([name, f]: [string, any]) => {
        if (!isRec(f)) return [name, f];
        const nf: Record<string, any> = { ...f };
        for (const k of ["offset", "at", "col"])
          if (typeof nf[k] === "number" || typeof nf[k] === "bigint")
            nf[k] = numStr(nf[k]);
        if (isRec(nf.row)) {
          nf.row = { index: null, match: null, ...nf.row };
          if (
            typeof nf.row.index === "number" ||
            typeof nf.row.index === "bigint"
          )
            nf.row.index = numStr(nf.row.index);
          if (isRec(nf.row.match) && typeof nf.row.match.col === "number")
            nf.row.match = { ...nf.row.match, col: numStr(nf.row.match.col) };
        }
        return [name, nf];
      }),
    );
  }
  return out;
}

function normFinality(f: any): any {
  if (!isRec(f)) return f;
  return { lagMs: numStr(f.lagMs), mode: f.mode, n: numStr(f.n) ?? null };
}

function normInput(x: any): any {
  if (!isRec(x)) return x;
  const out: Record<string, any> = { ...x, decode: normDecode(x.decode) };
  const read = isRec(x.read) ? { ...x.read } : x.read;
  switch (x.kind) {
    case "http":
      read.method ??= "GET";
      read.headers ??= {};
      read.body ??= null;
      break;
    case "evm":
      out.finality = normFinality(x.finality);
      if (read.method === "call") {
        read.data ??= null;
        read.sig ??= null;
        read.args ??= read.sig !== null ? [] : null;
      }
      break;
    case "starknet":
      out.finality = normFinality(x.finality);
      if (read.method === "call") read.calldata ??= [];
      break;
    case "svm":
      out.maxAgeMs = numStr(x.maxAgeMs);
      if (read.method === "account") {
        read.dataSlice = read.dataSlice
          ? {
              offset: numStr(read.dataSlice.offset),
              length: numStr(read.dataSlice.length),
            }
          : null;
      }
      break;
  }
  out.read = read;
  return out;
}

/** The full-form document a {@link SourceInput} stands for. */
export function sourceDocFor(input: SourceInput): SourceDoc {
  const numeric =
    input.output.type === "int256" || input.output.type === "uint256";
  return {
    v: "1",
    inputs: Object.fromEntries(
      Object.entries(input.inputs).map(([name, x]) => [name, normInput(x)]),
    ),
    transform: normExpr(input.transform),
    assert: (input.assert ?? []).map(normExpr),
    output: {
      type: input.output.type,
      decimals: numeric
        ? (numStr(input.output.decimals) as string)
        : (numStr(input.output.decimals) ?? null),
    },
    aggregation: input.aggregation
      ? {
          mode: "tolerance",
          rule: "median",
          maxDeviationBps: numStr(input.aggregation.maxDeviationBps) as string,
          maxAgeMs: numStr(input.aggregation.maxAgeMs) as string,
        }
      : null,
  };
}

/** Fill in the defaults of a short-form source and validate it. Throws a `SourceError` with a path. */
export function defineSource(input: SourceInput): ParsedSource {
  return parseSource(sourceDocFor(input));
}

/**
 * The common case: GET `url`, read the JSON value at `path`, scale it to `decimals`, and encode it as an
 * int256. `valueIs: "string"` parses a JSON string such as `"65000.12"`; `"number"` (the default) takes
 * a JSON number as is. Add `tolerance` to aggregate by median instead of requiring identical values.
 */
export function jsonPriceSource(o: {
  url: string;
  path: string;
  decimals: Num;
  valueIs?: "number" | "string";
  headers?: Record<string, string>;
  tolerance?: { maxDeviationBps: Num; maxAgeMs: Num };
}): ParsedSource {
  const value = o.valueIs === "string" ? num(ref("px.value")) : ref("px.value");
  return defineSource({
    inputs: {
      px: httpInput({
        url: o.url,
        headers: o.headers,
        decode: jsonDecode({ value: o.path }),
      }),
    },
    transform: rescale(value, { scale: o.decimals }),
    output: { type: "int256", decimals: o.decimals },
    aggregation: o.tolerance ?? null,
  });
}

/** Tolerance mode needs at least this many signers; nodes and the gateway reject fewer. */
export const MIN_TOLERANCE_SIGNATURES = 3;

/** Throws unless a tolerance source is asked for at least 3 signatures. No-op for exact mode. */
export function assertToleranceQuorum(
  src: ParsedSource,
  signaturesRequired: number,
): void {
  if (src.tolerance && signaturesRequired < MIN_TOLERANCE_SIGNATURES) {
    throw new Error(
      `tolerance aggregation requires signaturesRequired >= ${MIN_TOLERANCE_SIGNATURES}, got ${signaturesRequired}`,
    );
  }
}

/** A {@link ParsedSource} as is; a source document (text or object) parsed and validated. */
export function asParsedSource(
  source: ParsedSource | string | object,
): ParsedSource {
  if (
    typeof source === "object" &&
    source !== null &&
    "canonical" in source &&
    "idHex" in source &&
    "doc" in source
  )
    return source as ParsedSource;
  return parseSource(source as string | object);
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

const toHexStr = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Render a signed 32-byte value for people, according to the source's output: a scaled integer with
 * its decimal point, a bool, a string32's text, or hex. It is display only; nothing here is signed.
 */
export function formatValue(
  valuePacked: string,
  output: { type: OutputType; decimals: number },
): string {
  const bytes = hexToBytes(valuePacked);
  if (bytes.length !== 32)
    throw new Error(`value must be 32 bytes, got ${bytes.length}`);
  if (output.type === "int256" || output.type === "uint256") {
    let n = BigInt("0x" + toHexStr(bytes));
    if (output.type === "int256" && n >= 1n << 255n) n -= 1n << 256n;
    const neg = n < 0n;
    let digits = (neg ? -n : n).toString();
    if (output.decimals > 0) {
      digits = digits.padStart(output.decimals + 1, "0");
      const point = digits.length - output.decimals;
      digits =
        digits.slice(0, point) + "." + digits.slice(point).replace(/0+$/, "");
      digits = digits.replace(/\.$/, "");
    }
    return neg && digits !== "0" ? "-" + digits : digits;
  }
  if (output.type === "bool") return bytes[31] === 1 ? "true" : "false";
  if (output.type === "string32") {
    let end = 32;
    while (end > 0 && bytes[end - 1] === 0) end--;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.slice(0, end),
      );
    } catch {
      /* fall through to hex */
    }
  }
  return "0x" + toHexStr(bytes);
}

/** Whether `preimageHex` hashes (keccak256) to the signed value, as a `keccak256` output requires. */
export function verifyPreimage(
  valuePacked: string,
  preimageHex: string,
): boolean {
  let preimage: Uint8Array;
  try {
    preimage = hexToBytes(preimageHex);
  } catch {
    return false;
  }
  return (
    toHexStr(keccak_256(preimage)) ===
    valuePacked.replace(/^0x/, "").toLowerCase()
  );
}

// ---------------------------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------------------------

/**
 * Solana programs known to write their accounts every slot (AMM pools, order books). The list is
 * not exhaustive: it is for catching the common mistake, not for proving a source safe.
 */
export const PER_SLOT_WRITE_PROGRAMS: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: "OpenBook v2",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin": "Serum v3",
};

export interface LintFinding {
  severity: "error" | "warning";
  /** The input the finding is about. */
  input: string;
  message: string;
}

/**
 * Advisory checks that need more than the schema. An svm account read in exact mode works only if the
 * account changes slowly: nodes land on slots a few hundred ms apart, and exact mode signs only when
 * every node decodes the same bytes. With `ownerOf` (an RPC lookup of the account's owner program) a
 * read of an account owned by a known per-slot-write program is an error; without it every svm account
 * read in exact mode is a warning.
 */
export async function lintSource(
  src: ParsedSource,
  opts: {
    ownerOf?: (chain: string, address: string) => Promise<string | undefined>;
  } = {},
): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  if (src.tolerance) return findings;
  for (const name of src.inputNames) {
    const input = (src.doc.inputs as Record<string, any>)[name];
    if (input.kind !== "svm" || input.read.method !== "account") continue;
    if (opts.ownerOf) {
      const owner = await opts.ownerOf(input.chain, input.read.address);
      const known = owner ? PER_SLOT_WRITE_PROGRAMS[owner] : undefined;
      if (known) {
        findings.push({
          severity: "error",
          input: name,
          message: `account ${input.read.address} is owned by ${known}, which writes it every slot: nodes will read different bytes. Use tolerance aggregation.`,
        });
      }
      continue;
    }
    findings.push({
      severity: "warning",
      input: name,
      message:
        "an svm account read in exact mode signs only when every node decodes the same bytes; if this account is written every slot (an AMM pool, an order book) use tolerance aggregation.",
    });
  }
  return findings;
}
