/**
 * Molpha source format: parse, validate, canonicalize and hash.
 *
 * A source says what a feed reads, how the reads become one value, and how that value becomes the
 * 32 bytes that are signed. Its ID is `keccak256` of its canonical bytes. The reference is the node
 * client (`new/source`, documented in docs/source-format.md); this file reproduces its canonical form
 * and its validation, and is held to the same vectors (`test/source-vectors.json`). Nothing here
 * evaluates a source: only nodes do.
 *
 * The canonical form is a subset of RFC 8785: UTF-8, object keys sorted, no whitespace, ECMAScript
 * string escaping, and no JSON numbers at all. Every numeric quantity is a string in a fixed grammar.
 *
 * This file is kept byte-identical in `@molpha/gateway-sdk` and `@molpha/sdk`.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { CHAIN_LIST, type Chain } from "./chainlist.js";

export type SourceErrorClass =
  | "syntax"
  | "utf8"
  | "surrogate"
  | "number"
  | "duplicate_key"
  | "depth"
  | "unknown_key"
  | "missing_key"
  | "type"
  | "value"
  | "limit"
  | "noncanonical"
  | "reference";

/** A rejected source. `path` names the offending field; it never contains a secret. */
export class SourceError extends Error {
  constructor(
    public readonly path: string,
    public readonly errorClass: SourceErrorClass,
    message: string,
  ) {
    super(
      path
        ? `source: ${path}: ${errorClass}: ${message}`
        : `source: ${errorClass}: ${message}`,
    );
    this.name = "SourceError";
  }
}

export const SOURCE_VERSION = "1";
export const MAX_CANONICAL_BYTES = 8 * 1024;
export const MAX_PRIVATE_BYTES = 16 * 1024;
export const MAX_INPUTS = 4;
export const MAX_EXPR_NODES = 64;
export const MAX_EXPR_DEPTH = 12;
export const MAX_ASSERTS = 8;
export const MAX_FIELDS = 16;
export const MAX_HEADERS = 16;
export const MAX_HEADER_VALUE = 1024;
export const MAX_BODY_TEXT = 4096;
export const MAX_RESPONSE_BYTES = 1 << 20;
export const MAX_DECIMAL_SCALE = 36;
export const MAX_OUTPUT_DECIMALS = 36;
const MAX_RAW_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;

// ---------------------------------------------------------------------------------------------
// JSON values
// ---------------------------------------------------------------------------------------------

/** A parsed JSON value. Objects are Maps, so a key such as `__proto__` is just a key. */
export type Json = null | boolean | string | Json[] | JObj;
export type JObj = Map<string, Json>;

function kindName(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "object";
  return typeof v === "boolean" ? "boolean" : "string";
}

const isObj = (v: Json): v is JObj => v instanceof Map;

/** Convert plain JavaScript data to Json, refusing numbers and anything else the format forbids. */
export function fromPlain(value: unknown, path = "", depth = 0): Json {
  if (depth > MAX_JSON_DEPTH)
    throw new SourceError(
      path,
      "depth",
      `nesting deeper than ${MAX_JSON_DEPTH}`,
    );
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      if (!isWellFormed(value))
        throw new SourceError(path, "surrogate", "lone surrogate in string");
      return value;
    case "boolean":
      return value;
    case "number":
    case "bigint":
      throw new SourceError(
        path,
        "number",
        "JSON numbers are not allowed: write numbers as strings",
      );
    case "object": {
      if (Array.isArray(value))
        return value.map((v, i) => fromPlain(v, `${path}[${i}]`, depth + 1));
      const out: JObj = new Map();
      for (const [k, v] of value instanceof Map
        ? value.entries()
        : Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        out.set(k, fromPlain(v, path ? `${path}.${k}` : k, depth + 1));
      }
      return out;
    }
  }
  throw new SourceError(
    path,
    "type",
    `unsupported value of type ${typeof value}`,
  );
}

/** Back to plain objects (insertion-ordered), for callers that want to read a validated source. */
export function toPlain(v: Json): unknown {
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of v)
      Object.defineProperty(o, k, {
        value: toPlain(x),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return o;
  }
  return v;
}

function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

class Parser {
  pos = 0;
  constructor(readonly s: string) {}

  err(cls: SourceErrorClass, msg: string): never {
    throw new SourceError("", cls, msg);
  }

  ws(): void {
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else return;
    }
  }

  value(depth: number): Json {
    if (depth > MAX_JSON_DEPTH)
      this.err("depth", `nesting deeper than ${MAX_JSON_DEPTH}`);
    if (this.pos >= this.s.length)
      this.err("syntax", "unexpected end of input");
    const c = this.s[this.pos]!;
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') return this.string();
    if (c === "t") return this.literal("true", true);
    if (c === "f") return this.literal("false", false);
    if (c === "n") return this.literal("null", null);
    if (c === "-" || (c >= "0" && c <= "9"))
      this.err(
        "number",
        `JSON numbers are not allowed (offset ${this.pos}): write numbers as strings`,
      );
    return this.err(
      "syntax",
      `unexpected character ${JSON.stringify(c)} at offset ${this.pos}`,
    );
  }

  literal(word: string, v: Json): Json {
    if (!this.s.startsWith(word, this.pos))
      this.err("syntax", `invalid literal at offset ${this.pos}`);
    this.pos += word.length;
    return v;
  }

  object(depth: number): Json {
    this.pos++;
    const out: JObj = new Map();
    this.ws();
    if (this.s[this.pos] === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.pos] !== '"')
        this.err("syntax", `expected object key at offset ${this.pos}`);
      const key = this.string();
      if (out.has(key))
        this.err("duplicate_key", `duplicate key ${JSON.stringify(key)}`);
      this.ws();
      if (this.s[this.pos] !== ":")
        this.err("syntax", `expected ':' at offset ${this.pos}`);
      this.pos++;
      this.ws();
      out.set(key, this.value(depth + 1));
      this.ws();
      if (this.pos >= this.s.length) this.err("syntax", "unterminated object");
      const c = this.s[this.pos++];
      if (c === ",") continue;
      if (c === "}") return out;
      this.err("syntax", `expected ',' or '}' at offset ${this.pos - 1}`);
    }
  }

  array(depth: number): Json {
    this.pos++;
    const out: Json[] = [];
    this.ws();
    if (this.s[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth + 1));
      this.ws();
      if (this.pos >= this.s.length) this.err("syntax", "unterminated array");
      const c = this.s[this.pos++];
      if (c === ",") continue;
      if (c === "]") return out;
      this.err("syntax", `expected ',' or ']' at offset ${this.pos - 1}`);
    }
  }

  hex4(): number {
    const h = this.s.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.err("syntax", "invalid \\u escape");
    this.pos += 4;
    return parseInt(h, 16);
  }

  string(): string {
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.s.length) this.err("syntax", "unterminated string");
      const c = this.s[this.pos]!;
      const code = c.charCodeAt(0);
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (code < 0x20)
        this.err(
          "syntax",
          `raw control character in string at offset ${this.pos}`,
        );
      if (c === "\\") {
        this.pos++;
        const e = this.s[this.pos++];
        switch (e) {
          case '"':
          case "\\":
          case "/":
            out += e;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const r = this.hex4();
            if (r >= 0xd800 && r <= 0xdbff) {
              if (this.s[this.pos] !== "\\" || this.s[this.pos + 1] !== "u")
                this.err("surrogate", "lone high surrogate");
              this.pos += 2;
              const lo = this.hex4();
              if (lo < 0xdc00 || lo > 0xdfff)
                this.err(
                  "surrogate",
                  "high surrogate not followed by a low surrogate",
                );
              out += String.fromCharCode(r, lo);
            } else if (r >= 0xdc00 && r <= 0xdfff) {
              this.err("surrogate", "lone low surrogate");
            } else {
              out += String.fromCharCode(r);
            }
            break;
          }
          default:
            this.err("syntax", `invalid escape \\${e ?? ""}`);
        }
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const d = this.s.charCodeAt(this.pos + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff))
          this.err("surrogate", "lone surrogate in input");
        out += c + this.s[this.pos + 1];
        this.pos += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff)
        this.err("surrogate", "lone surrogate in input");
      out += c;
      this.pos++;
    }
  }
}

/** Strictly parse source JSON: no numbers, no duplicate keys, no lone surrogates, no trailing data. */
export function parseStrict(input: string | Uint8Array): Json {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        input,
      );
    } catch {
      throw new SourceError("", "utf8", "invalid UTF-8");
    }
  }
  const p = new Parser(text);
  p.ws();
  const v = p.value(0);
  p.ws();
  if (p.pos !== text.length)
    throw new SourceError("", "syntax", `trailing data at offset ${p.pos}`);
  return v;
}

/** The canonical serialization of a parsed value. */
export function canonicalJson(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = [...v.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(v.get(k)!))
      .join(",") +
    "}"
  );
}

/** The canonical bytes of a source document (any JSON text or plain object), without schema checks. */
export function canonicalize(input: string | Uint8Array | object): string {
  return canonicalJson(
    typeof input === "string" || input instanceof Uint8Array
      ? parseStrict(input)
      : fromPlain(input),
  );
}

const enc = new TextEncoder();
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------------------------
// Grammars
// ---------------------------------------------------------------------------------------------

const isUint = (s: string): boolean =>
  s.length <= 78 && /^(0|[1-9][0-9]*)$/.test(s);
const isInt = (s: string): boolean =>
  s.startsWith("-") ? s !== "-0" && isUint(s.slice(1)) : isUint(s);
function isDec(s: string): boolean {
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]*[1-9]))?$/.exec(s);
  if (!m) return false;
  const frac = m[3] ?? "";
  if (frac.length > MAX_DECIMAL_SCALE) return false;
  if (m[1] === "-" && m[2] === "0" && frac === "") return false;
  return m[2]!.length + frac.length <= 76;
}
function parseUint(s: string, max: bigint | number): bigint | null {
  if (!isUint(s)) return null;
  const n = BigInt(s);
  return n > BigInt(max) ? null : n;
}
const isLowerHex = (s: string): boolean =>
  /^0x[0-9a-f]*$/.test(s) && s.length >= 2;
const isHexBytes = (s: string): boolean => isLowerHex(s) && s.length % 2 === 0;
const isAddr = (s: string): boolean => /^0x[0-9a-f]{40}$/.test(s);
const isName = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(s);
const isPrintable = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function isPubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const c of s) {
    const d = B58.indexOf(c);
    if (d < 0) return false;
    n = n * 58n + BigInt(d);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return zeros + bytes === 32;
}

const STARKNET_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
function isFelt(s: string): boolean {
  if (!isLowerHex(s) || s.length < 3 || s.length > 2 + 64) return false;
  if (s.length > 3 && s[2] === "0") return false;
  return BigInt(s) < STARKNET_PRIME;
}

// ---------------------------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------------------------

const join = (path: string, key: string): string =>
  path ? `${path}.${key}` : key;

function exact(v: Json, path: string, keys: string[]): JObj {
  if (!isObj(v))
    throw new SourceError(path, "type", `expected object, got ${kindName(v)}`);
  const want = new Set(keys);
  for (const k of v.keys())
    if (!want.has(k))
      throw new SourceError(join(path, k), "unknown_key", "unknown key");
  for (const k of keys)
    if (!v.has(k))
      throw new SourceError(join(path, k), "missing_key", "missing key");
  return v;
}

function str(v: Json | undefined, path: string): string {
  if (typeof v !== "string")
    throw new SourceError(
      path,
      "type",
      `expected string, got ${kindName(v ?? null)}`,
    );
  return v;
}
const optStr = (v: Json, path: string): string | null =>
  v === null ? null : str(v, path);
function bool(v: Json, path: string): boolean {
  if (typeof v !== "boolean")
    throw new SourceError(path, "type", `expected boolean, got ${kindName(v)}`);
  return v;
}
function uintField(v: Json, path: string, min: number, max: number): number {
  const s = str(v, path);
  const n = parseUint(s, max);
  if (n === null)
    throw new SourceError(
      path,
      "value",
      `must be an unsigned integer string of at most ${max} (no sign, no leading zeros)`,
    );
  if (n < BigInt(min))
    throw new SourceError(path, "value", `must be at least ${min}`);
  return Number(n);
}
function oneOf(path: string, s: string, allowed: string[]): void {
  if (!allowed.includes(s))
    throw new SourceError(
      path,
      "value",
      `must be one of ${allowed.join(", ")}`,
    );
}
function val(path: string, msg: string): never {
  throw new SourceError(path, "value", msg);
}

const ROUND_MODES = ["halfEven", "down", "up", "halfUp"];

interface Ops {
  min: number;
  max: number;
  params: string[];
}
const OPS: Record<string, Ops> = {
  num: { min: 1, max: 1, params: ["mode"] },
  int: { min: 1, max: 1, params: [] },
  str: { min: 1, max: 1, params: [] },
  hexBytes: { min: 1, max: 1, params: [] },
  add: { min: 2, max: 2, params: [] },
  sub: { min: 2, max: 2, params: [] },
  mul: { min: 2, max: 2, params: [] },
  min: { min: 2, max: 2, params: [] },
  max: { min: 2, max: 2, params: [] },
  neg: { min: 1, max: 1, params: [] },
  abs: { min: 1, max: 1, params: [] },
  div: { min: 2, max: 2, params: ["round", "scale"] },
  rescale: { min: 1, max: 1, params: ["round", "scale"] },
  shift: { min: 1, max: 1, params: ["n"] },
  eq: { min: 2, max: 2, params: [] },
  ne: { min: 2, max: 2, params: [] },
  lt: { min: 2, max: 2, params: [] },
  lte: { min: 2, max: 2, params: [] },
  gt: { min: 2, max: 2, params: [] },
  gte: { min: 2, max: 2, params: [] },
  if: { min: 3, max: 3, params: [] },
  coalesce: { min: 2, max: 2, params: [] },
  keccak256: { min: 1, max: 1, params: [] },
  concat: { min: 2, max: 8, params: [] },
  slice: { min: 1, max: 1, params: ["len", "off"] },
  lower: { min: 1, max: 1, params: [] },
  upper: { min: 1, max: 1, params: [] },
};

interface ExprCtx {
  leaves: Set<string>;
  allowOut: boolean;
  allowBlock: boolean;
  nodes: { n: number };
}

function checkOpParam(name: string, s: string): string | null {
  switch (name) {
    case "mode":
      return ["dec", "hex", "sci"].includes(s)
        ? null
        : 'must be "dec", "hex" or "sci"';
    case "round":
      return ROUND_MODES.includes(s)
        ? null
        : 'must be "halfEven", "down", "up" or "halfUp"';
    case "scale":
      return parseUint(s, MAX_DECIMAL_SCALE) === null
        ? `must be an unsigned integer string of at most ${MAX_DECIMAL_SCALE}`
        : null;
    case "n": {
      if (!isInt(s) || s.length > 3 || Math.abs(Number(s)) > MAX_DECIMAL_SCALE)
        return `must be an integer string between -${MAX_DECIMAL_SCALE} and ${MAX_DECIMAL_SCALE}`;
      return null;
    }
    case "off":
    case "len":
      return parseUint(s, 1024) === null
        ? "must be an unsigned integer string of at most 1024"
        : null;
  }
  return null;
}

function checkExpr(v: Json, path: string, ctx: ExprCtx, depth: number): void {
  if (++ctx.nodes.n > MAX_EXPR_NODES)
    throw new SourceError(
      path,
      "limit",
      `more than ${MAX_EXPR_NODES} expression nodes in the transform and assertions together`,
    );
  if (depth > MAX_EXPR_DEPTH)
    throw new SourceError(
      path,
      "limit",
      `expression deeper than ${MAX_EXPR_DEPTH}`,
    );
  if (!isObj(v))
    throw new SourceError(
      path,
      "type",
      `expected an expression object, got ${kindName(v)}`,
    );
  if (v.has("op")) {
    const op = v.get("op")!;
    if (typeof op !== "string")
      throw new SourceError(path + ".op", "type", "expected string");
    const spec = OPS[op];
    if (!spec || !Object.prototype.hasOwnProperty.call(OPS, op))
      throw new SourceError(
        path + ".op",
        "value",
        `unknown operator ${JSON.stringify(op)}`,
      );
    const m = exact(v, path, ["args", "op", ...spec.params]);
    const args = m.get("args")!;
    if (!Array.isArray(args))
      throw new SourceError(path + ".args", "type", "expected array");
    if (args.length < spec.min || args.length > spec.max) {
      throw new SourceError(
        path + ".args",
        "value",
        `${op} takes ${spec.min}..${spec.max} arguments, got ${args.length}`,
      );
    }
    args.forEach((a, i) => checkExpr(a, `${path}.args[${i}]`, ctx, depth + 1));
    for (const p of spec.params) {
      const s = str(m.get(p), `${path}.${p}`);
      const bad = checkOpParam(p, s);
      if (bad) val(`${path}.${p}`, bad);
    }
    return;
  }
  if (v.size !== 1)
    val(
      path,
      "an expression is {ref}, {const}, {str}, {bytes}, {bool} or {op,args,...}",
    );
  const [key, x] = [...v.entries()][0]!;
  const p = `${path}.${key}`;
  switch (key) {
    case "ref": {
      const s = str(x, p);
      if (s === "$ts") return;
      if (s === "$block") {
        if (!ctx.allowBlock)
          throw new SourceError(
            p,
            "reference",
            "$block needs exactly one chain input",
          );
        return;
      }
      if (s === "$out") {
        if (!ctx.allowOut)
          throw new SourceError(
            p,
            "reference",
            "$out is only available in assertions",
          );
        return;
      }
      if (!ctx.leaves.has(s))
        throw new SourceError(
          p,
          "reference",
          `${JSON.stringify(s)} is not a field of any input`,
        );
      return;
    }
    case "const":
      if (!isDec(str(x, p))) val(p, "must be a canonical decimal string");
      return;
    case "str":
      if (str(x, p).length > 1024)
        throw new SourceError(p, "limit", "longer than 1024 bytes");
      return;
    case "bytes": {
      const s = str(x, p);
      if (!isHexBytes(s) || s.length > 2 + 2 * 1024)
        val(
          p,
          "must be 0x-prefixed lowercase hex of whole bytes, at most 1024 bytes",
        );
      return;
    }
    case "bool":
      bool(x, p);
      return;
  }
  throw new SourceError(p, "unknown_key", "unknown expression key");
}

// -- selectors ---------------------------------------------------------------------------------

const MAX_PATH_LEN = 256;
const MAX_PATH_SEGS = 16;
const isPathNameChar = (c: string): boolean => /[A-Za-z0-9_-]/.test(c);
const plainQuoted = (s: string): boolean =>
  s.length > 0 && s.length <= 64 && isPrintable(s) && !/['\\]/.test(s);

/** Throws a message string if `p` is not in the JSON path subset the json decoder reads. */
function checkJSONPath(p: string): string | null {
  if (p.length > MAX_PATH_LEN || !isPrintable(p))
    return "path is too long or not printable ASCII";
  if (!p.startsWith("$")) return "path must start with $";
  let i = 1;
  let segs = 0;
  while (i < p.length) {
    if (++segs > MAX_PATH_SEGS)
      return `path has more than ${MAX_PATH_SEGS} segments`;
    if (p[i] === ".") {
      let j = i + 1;
      while (j < p.length && isPathNameChar(p[j]!)) j++;
      const name = p.slice(i + 1, j);
      if (name === "") return `empty key at byte ${i}`;
      if (name === "length" && p.startsWith("()", j))
        return j + 2 === p.length ? null : "length() must be the last segment";
      i = j;
    } else if (p[i] === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) return `unterminated [ at byte ${i}`;
      const inner = p.slice(i + 1, end);
      const bad = checkBracket(inner);
      if (bad) return bad;
      i = end + 1;
    } else {
      return `unexpected ${JSON.stringify(p[i])} at byte ${i}`;
    }
  }
  return null;
}

function checkBracket(inner: string): string | null {
  if (inner.startsWith("'")) {
    if (inner.length < 3 || !inner.endsWith("'")) return "malformed quoted key";
    return plainQuoted(inner.slice(1, -1))
      ? null
      : "quoted key must be 1-64 printable characters without ' or \\";
  }
  if (inner.startsWith("?(@.")) {
    if (!inner.endsWith(")")) return "malformed filter";
    const body = inner.slice("?(@.".length, -1);
    let at = body.indexOf("==");
    if (at < 0) at = body.indexOf("!=");
    if (at <= 0) return "filter needs == or !=";
    const key = body.slice(0, at);
    const rest = body.slice(at + 2);
    if (![...key].every(isPathNameChar)) return "invalid filter key";
    if (
      rest.length < 2 ||
      rest[0] !== "'" ||
      rest[rest.length - 1] !== "'" ||
      !(plainQuoted(rest.slice(1, -1)) || rest === "''")
    ) {
      return "filter value must be a single-quoted plain string";
    }
    return null;
  }
  if (!isInt(inner)) return "index must be an integer";
  return Math.abs(Number(inner)) > 1_000_000 ? "index out of range" : null;
}

function isXName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(s);
}

/** Returns an error message, or null; `prefixes` collects the namespace prefixes the path uses. */
function checkXPath(p: string, prefixes: Set<string>): string | null {
  if (p.length > MAX_PATH_LEN || !isPrintable(p) || !p.startsWith("/"))
    return "xpath must be absolute printable ASCII";
  const parts: string[] = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < p.length; i++) {
    const c = p[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "/" && depth === 0) {
      parts.push(p.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(p.slice(start));
  if (parts.length < 2)
    return "xpath needs at least one element and a /text() or /@attr end";
  const last = parts[parts.length - 1]!;
  if (!(
    last === "text()" ||
    (last.startsWith("@") && isXName(last.slice(1)) && !last.includes(":"))
  ))
    return "xpath must end with /text() or /@attr";
  const steps = parts.slice(0, -1);
  if (steps.length > MAX_PATH_SEGS)
    return `xpath has more than ${MAX_PATH_SEGS} steps`;
  for (const part of steps) {
    let name = part;
    const at = part.indexOf("[");
    if (at >= 0) {
      name = part.slice(0, at);
      let pred = part.slice(at);
      if (!pred.endsWith("]") || pred.split("[").length !== 2)
        return `malformed predicate in ${JSON.stringify(part)}`;
      pred = pred.slice(1, -1);
      if (pred.startsWith("@")) {
        const eq = pred.indexOf("=");
        const attr = eq < 0 ? "" : pred.slice(1, eq);
        const value = eq < 0 ? "" : pred.slice(eq + 1);
        if (
          eq < 0 ||
          !isXName(attr) ||
          attr.includes(":") ||
          value.length < 2 ||
          value[0] !== "'" ||
          value[value.length - 1] !== "'" ||
          !(plainQuoted(value.slice(1, -1)) || value === "''")
        )
          return "predicate must be [n] or [@attr='x']";
      } else {
        const n = parseUint(pred, 1_000_000);
        if (n === null || n === 0n)
          return "predicate must be [n] with n >= 1 or [@attr='x']";
      }
    }
    if (!isXName(name) || name.split(":").length > 2)
      return `invalid element name ${JSON.stringify(name)}`;
    const [pre, local] = name.includes(":") ? name.split(":") : [null, name];
    if (pre !== null) {
      if (!isXName(pre!) || !isXName(local!))
        return `invalid element name ${JSON.stringify(name)}`;
      prefixes.add(pre!);
    }
  }
  return null;
}

// -- ABI types ---------------------------------------------------------------------------------

type ABIType =
  | { kind: "uint" | "int"; bits: number }
  | { kind: "address" | "bool" | "bytes" | "string" }
  | { kind: "fixedBytes"; size: number }
  | { kind: "array"; elem: ABIType; fixed: boolean; size: number }
  | { kind: "tuple"; elems: ABIType[] };

function parseABI(
  s: string,
  depth: number,
  parts: { n: number },
): [ABIType, string] {
  if (depth > 4) throw new Error("type nested deeper than 4");
  if (++parts.n > 32) throw new Error("type has more than 32 parts");
  let t: ABIType;
  let rest: string;
  if (s.startsWith("(")) {
    rest = s.slice(1);
    if (rest.startsWith(")")) throw new Error("empty tuple");
    const elems: ABIType[] = [];
    for (;;) {
      const [e, r] = parseABI(rest, depth + 1, parts);
      elems.push(e);
      if (r.startsWith(",")) {
        rest = r.slice(1);
        continue;
      }
      if (r.startsWith(")")) {
        rest = r.slice(1);
        break;
      }
      throw new Error("malformed tuple");
    }
    t = { kind: "tuple", elems };
  } else {
    const m = /^[a-z0-9]*/.exec(s)!;
    const word = m[0];
    rest = s.slice(word.length);
    if (
      word === "address" ||
      word === "bool" ||
      word === "string" ||
      word === "bytes"
    )
      t = { kind: word };
    else if (word.startsWith("bytes")) {
      const n = parseUint(word.slice(5), 32);
      if (n === null || n === 0n) throw new Error(`invalid type ${word}`);
      t = { kind: "fixedBytes", size: Number(n) };
    } else if (word.startsWith("uint") || word.startsWith("int")) {
      const bits = parseUint(word.replace(/^u?int/, ""), 256);
      if (bits === null || bits === 0n || bits % 8n !== 0n)
        throw new Error(`invalid type ${word}`);
      t = { kind: word[0] === "i" ? "int" : "uint", bits: Number(bits) };
    } else throw new Error(`unknown type ${word}`);
  }
  while (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) throw new Error("unterminated array suffix");
    const inner = rest.slice(1, close);
    let arr: ABIType = { kind: "array", elem: t, fixed: false, size: 0 };
    if (inner !== "") {
      const n = Number(inner);
      if (!isUint(inner) || n === 0 || n > 1024)
        throw new Error(`invalid array length ${inner}`);
      arr = { kind: "array", elem: t, fixed: true, size: n };
    }
    t = arr;
    rest = rest.slice(close + 1);
  }
  return [t, rest];
}

function parseABIType(s: string): ABIType {
  const [t, rest] = parseABI(s, 0, { n: 0 });
  if (rest !== "")
    throw new Error(`trailing text ${JSON.stringify(rest)} in type`);
  return t;
}

function parseSig(sig: string): ABIType[] {
  const open = sig.indexOf("(");
  if (open <= 0 || !sig.endsWith(")"))
    throw new Error("signature must look like name(type,type)");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sig.slice(0, open)))
    throw new Error("invalid function name");
  const inner = sig.slice(open + 1, -1);
  if (inner === "") return [];
  const types = inner.split(",").map((p) => {
    const t = parseABIType(p);
    if (!["uint", "int", "address", "bool", "fixedBytes"].includes(t.kind))
      throw new Error(
        `argument type ${JSON.stringify(p)} is not static elementary; pass raw calldata in data`,
      );
    return t;
  });
  if (types.length > 8) throw new Error("at most 8 arguments");
  return types;
}

function checkABIArg(t: ABIType, s: string): string | null {
  switch (t.kind) {
    case "uint":
    case "int": {
      if (!isInt(s)) return "must be a canonical integer string";
      const n = BigInt(s);
      if (t.kind === "uint")
        return n < 0n || n >= 1n << BigInt(t.bits)
          ? `does not fit uint${t.bits}`
          : null;
      const lim = 1n << BigInt(t.bits - 1);
      return n < -lim || n >= lim ? `does not fit int${t.bits}` : null;
    }
    case "address":
      return isAddr(s)
        ? null
        : "must be a 0x-prefixed lowercase 20-byte address";
    case "bool":
      return s === "true" || s === "false" ? null : 'must be "true" or "false"';
    case "fixedBytes":
      return isHexBytes(s) && s.length === 2 + 2 * t.size
        ? null
        : `must be 0x-prefixed lowercase hex of ${t.size} bytes`;
  }
  return null;
}

function checkPick(pick: string, types: ABIType[]): string | null {
  const idx: number[] = [];
  for (const p of pick.split(".")) {
    const n = parseUint(p, 1 << 20);
    if (n === null)
      return "pick must be dot-separated indexes such as 0 or 1.2";
    idx.push(Number(n));
  }
  if (idx[0]! >= types.length)
    return `pick ${idx[0]} is past the ${types.length} declared types`;
  let cur = types[idx[0]!]!;
  for (const i of idx.slice(1)) {
    if (cur.kind === "tuple") {
      if (i >= cur.elems.length)
        return `tuple has ${cur.elems.length} members, pick wants ${i}`;
      cur = cur.elems[i]!;
    } else if (cur.kind === "array") {
      if (cur.fixed && i >= cur.size)
        return `array has ${cur.size} elements, pick wants ${i}`;
      cur = cur.elem;
    } else return "pick goes deeper than the type";
  }
  return cur.kind === "array" || cur.kind === "tuple"
    ? "pick must end at a single value, not an array or tuple"
    : null;
}

// -- reads and inputs --------------------------------------------------------------------------

const LAYOUT_SIZES: Record<string, number> = {
  u8: 1,
  i8: 1,
  bool: 1,
  u16le: 2,
  i16le: 2,
  u32le: 4,
  i32le: 4,
  u64le: 8,
  i64le: 8,
  u128le: 16,
  i128le: 16,
  pubkey: 32,
};
function layoutSize(t: string): number | null {
  if (Object.prototype.hasOwnProperty.call(LAYOUT_SIZES, t))
    return LAYOUT_SIZES[t]!;
  const m = /^bytes\[([1-9][0-9]{0,3})\]$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 1024 ? n : null;
}

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "te",
  "upgrade",
  "expect",
]);
const isHeaderName = (s: string): boolean =>
  s.length > 0 && s.length <= 64 && /^[a-z0-9!#$%&'*+\-.^_`|~]+$/.test(s);

export interface URLParts {
  scheme: "http" | "https";
  host: string;
  port: string;
  /** Path and query, verbatim. */
  rest: string;
  /** host or host:port as the URL spells it. */
  hostPort: string;
}

/** Split a source URL. Scheme, host and port must be literal; throws on anything else. */
export function splitURL(u: string): URLParts {
  if (u === "" || u.length > 2048)
    throw new Error("url must be 1 to 2048 characters");
  if (!/^[\x21-\x7e]*$/.test(u))
    throw new Error(
      "url must be printable ASCII without spaces; percent-encode anything else",
    );
  let scheme: "http" | "https";
  if (u.startsWith("https://")) scheme = "https";
  else if (u.startsWith("http://")) scheme = "http";
  else throw new Error("url scheme must be http or https");
  const rest0 = u.slice(scheme.length + 3);
  const end = rest0.search(/[/?#]/);
  const authority = end >= 0 ? rest0.slice(0, end) : rest0;
  const rest = end >= 0 ? rest0.slice(end) : "";
  if (rest.includes("#")) throw new Error("url must not have a fragment");
  if (/[@{}]/.test(authority))
    throw new Error(
      "url must not have userinfo, and its host and port must be literal",
    );
  let host = authority;
  let port = "";
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) throw new Error("malformed IPv6 host");
    host = authority.slice(0, close + 1);
    const tail = authority.slice(close + 1);
    if (tail !== "") {
      if (!tail.startsWith(":")) throw new Error("malformed host");
      port = tail.slice(1);
    }
  } else {
    const i = authority.lastIndexOf(":");
    if (i >= 0) {
      host = authority.slice(0, i);
      port = authority.slice(i + 1);
    }
  }
  if (host === "") throw new Error("url has no host");
  if (host !== host.toLowerCase())
    throw new Error("url host must be lowercase");
  if (!/^[a-z0-9.\-[\]:]+$/.test(host))
    throw new Error("invalid character in host");
  if (port !== "" && (parseUint(port, 65535) === null || port === "0"))
    throw new Error("invalid port");
  return {
    scheme,
    host,
    port,
    rest,
    hostPort: port ? `${host}:${port}` : host,
  };
}

function checkHTTPRead(v: Json, path: string): void {
  const m = exact(v, path, ["body", "headers", "method", "url"]);
  const method = str(m.get("method"), path + ".method");
  oneOf(path + ".method", method, ["GET", "POST"]);
  try {
    splitURL(str(m.get("url"), path + ".url"));
  } catch (e) {
    val(path + ".url", (e as Error).message);
  }
  const hv = m.get("headers")!;
  if (!isObj(hv))
    throw new SourceError(
      path + ".headers",
      "type",
      `expected object, got ${kindName(hv)}`,
    );
  if (hv.size > MAX_HEADERS)
    throw new SourceError(
      path + ".headers",
      "limit",
      `at most ${MAX_HEADERS} headers`,
    );
  for (const [k, x] of hv) {
    const hp = `${path}.headers.${k}`;
    if (!isHeaderName(k))
      val(
        path + ".headers",
        `header name ${JSON.stringify(k)} must be a lowercase token`,
      );
    if (FORBIDDEN_HEADERS.has(k))
      val(
        hp,
        `header ${JSON.stringify(k)} is set by the transport and cannot be committed`,
      );
    const s = str(x, hp);
    if (s.length > MAX_HEADER_VALUE || !isPrintable(s) || s !== s.trim())
      val(
        hp,
        `must be printable ASCII without surrounding space, at most ${MAX_HEADER_VALUE} bytes`,
      );
  }
  const body = m.get("body")!;
  if (body !== null) {
    if (method === "GET") val(path + ".body", "a GET request has no body");
    const bm = exact(body, path + ".body", ["contentType", "text"]);
    const ct = str(bm.get("contentType"), path + ".body.contentType");
    if (ct === "" || ct.length > 128 || !isPrintable(ct))
      val(
        path + ".body.contentType",
        "must be 1 to 128 printable ASCII characters",
      );
    const text = str(bm.get("text"), path + ".body.text");
    if (enc.encode(text).length > MAX_BODY_TEXT)
      throw new SourceError(
        path + ".body.text",
        "limit",
        `at most ${MAX_BODY_TEXT} bytes`,
      );
  }
}

function methodOf(v: Json, path: string): string {
  if (!isObj(v))
    throw new SourceError(path, "type", `expected object, got ${kindName(v)}`);
  if (!v.has("method"))
    throw new SourceError(path + ".method", "missing_key", "missing key");
  return str(v.get("method"), path + ".method");
}

function addrField(v: Json | undefined, path: string): string {
  const s = str(v, path);
  if (!isAddr(s)) val(path, "must be a 0x-prefixed lowercase 20-byte address");
  return s;
}
function feltField(v: Json | undefined, path: string): string {
  const s = str(v, path);
  if (!isFelt(s))
    val(
      path,
      "must be a canonical felt: 0x, lowercase hex, no leading zeros, below the field prime",
    );
  return s;
}
function pubkeyField(v: Json | undefined, path: string): string {
  const s = str(v, path);
  if (!isPubkey(s)) val(path, "must be the base58 spelling of 32 bytes");
  return s;
}

function checkEVMRead(v: Json, path: string): void {
  const method = methodOf(v, path);
  if (method === "call") {
    const m = exact(v, path, ["args", "data", "method", "sig", "to"]);
    addrField(m.get("to"), path + ".to");
    const data = optStr(m.get("data")!, path + ".data");
    const sig = optStr(m.get("sig")!, path + ".sig");
    if ((data === null) === (sig === null))
      val(path, "give either data or sig with args, not both and not neither");
    if (data !== null) {
      if (
        !isHexBytes(data) ||
        data.length < 2 + 8 ||
        data.length > 2 + 2 * 1024
      )
        val(
          path + ".data",
          "must be 0x-prefixed lowercase hex of 4 to 1024 bytes",
        );
      if (m.get("args") !== null)
        val(path + ".args", "must be null when data is given");
      return;
    }
    let types: ABIType[];
    try {
      types = parseSig(sig!);
    } catch (e) {
      return val(path + ".sig", (e as Error).message);
    }
    const args = m.get("args")!;
    if (!Array.isArray(args))
      throw new SourceError(
        path + ".args",
        "type",
        "expected array when sig is given",
      );
    if (args.length !== types.length)
      val(
        path + ".args",
        `sig takes ${types.length} arguments, got ${args.length}`,
      );
    args.forEach((a, i) => {
      const ap = `${path}.args[${i}]`;
      const bad = checkABIArg(types[i]!, str(a, ap));
      if (bad) val(ap, bad);
    });
    return;
  }
  if (method === "storage") {
    const m = exact(v, path, ["address", "method", "slot"]);
    addrField(m.get("address"), path + ".address");
    const slot = str(m.get("slot"), path + ".slot");
    if (!isLowerHex(slot) || slot.length !== 66)
      val(path + ".slot", "must be 0x-prefixed lowercase hex of 32 bytes");
    return;
  }
  if (method === "balance") {
    const m = exact(v, path, ["address", "method"]);
    addrField(m.get("address"), path + ".address");
    return;
  }
  val(path + ".method", "must be one of call, storage, balance");
}

function checkStarknetRead(v: Json, path: string): void {
  const method = methodOf(v, path);
  if (method === "call") {
    const m = exact(v, path, ["calldata", "contract", "method", "selector"]);
    feltField(m.get("contract"), path + ".contract");
    const sel = str(m.get("selector"), path + ".selector");
    if (sel.length > 64 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sel))
      val(
        path + ".selector",
        "must be an entrypoint name of at most 64 characters",
      );
    const cd = m.get("calldata")!;
    if (!Array.isArray(cd))
      throw new SourceError(path + ".calldata", "type", "expected array");
    if (cd.length > 32)
      throw new SourceError(path + ".calldata", "limit", "at most 32 felts");
    cd.forEach((c, i) => feltField(c, `${path}.calldata[${i}]`));
    return;
  }
  if (method === "storage") {
    const m = exact(v, path, ["contract", "key", "method"]);
    feltField(m.get("contract"), path + ".contract");
    feltField(m.get("key"), path + ".key");
    return;
  }
  val(path + ".method", "must be one of call, storage");
}

interface SvmReadInfo {
  tokenSupply: boolean;
  dataSlice: { offset: number; length: number } | null;
}

function checkSVMRead(v: Json, path: string): SvmReadInfo {
  const method = methodOf(v, path);
  if (method === "account") {
    const m = exact(v, path, ["address", "dataSlice", "method"]);
    pubkeyField(m.get("address"), path + ".address");
    const ds = m.get("dataSlice")!;
    if (ds === null) return { tokenSupply: false, dataSlice: null };
    const sm = exact(ds, path + ".dataSlice", ["length", "offset"]);
    const length = uintField(
      sm.get("length")!,
      path + ".dataSlice.length",
      1,
      MAX_RESPONSE_BYTES,
    );
    const offset = uintField(
      sm.get("offset")!,
      path + ".dataSlice.offset",
      0,
      1 << 24,
    );
    return { tokenSupply: false, dataSlice: { offset, length } };
  }
  if (method === "tokenSupply") {
    const m = exact(v, path, ["method", "mint"]);
    pubkeyField(m.get("mint"), path + ".mint");
    return { tokenSupply: true, dataSlice: null };
  }
  return val(path + ".method", "must be one of account, tokenSupply");
}

const FORMATS: Record<string, string[]> = {
  http: ["json", "csv", "xml", "text", "raw"],
  evm: ["abi", "raw"],
  starknet: ["felts", "raw"],
  svm: ["layout", "raw"],
};

const CAIP: Record<string, RegExp> = {
  evm: /^eip155:[1-9][0-9]{0,18}$/,
  starknet: /^starknet:[A-Z0-9_]{1,32}$/,
  svm: /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/,
};

interface InputInfo {
  kind: string;
  leaves: string[];
}

function checkDecode(
  v: Json,
  path: string,
  kind: string,
  svm: SvmReadInfo | null,
): string[] {
  if (svm?.tokenSupply) {
    if (v !== null)
      val(
        path,
        "must be null for tokenSupply: its fields are amount and decimals",
      );
    return ["amount", "decimals"];
  }
  if (!isObj(v))
    throw new SourceError(path, "type", `expected object, got ${kindName(v)}`);
  if (!v.has("format"))
    throw new SourceError(path + ".format", "missing_key", "missing key");
  const format = str(v.get("format"), path + ".format");
  if (!FORMATS[kind]!.includes(format))
    val(
      path + ".format",
      `a ${kind} input decodes with one of ${FORMATS[kind]!.join(", ")}`,
    );
  if (format === "raw") {
    exact(v, path, ["format"]);
    return ["raw"];
  }
  const KEYS: Record<string, string[]> = {
    json: ["fields", "format"],
    text: ["fields", "format"],
    felts: ["fields", "format"],
    abi: ["fields", "format", "types"],
    layout: ["discriminator", "fields", "format"],
    csv: ["delimiter", "fields", "format", "header", "trim"],
    xml: ["fields", "format", "namespaces"],
  };
  const m = exact(v, path, KEYS[format]!);

  let header = false;
  const namespaces = new Set<string>();
  let types: ABIType[] = [];
  let hasDisc = false;
  if (format === "csv") {
    const delim = str(m.get("delimiter"), path + ".delimiter");
    if (
      delim.length !== 1 ||
      delim === '"' ||
      (delim !== "\t" && (delim < " " || delim > "~"))
    )
      val(
        path + ".delimiter",
        "must be one printable ASCII character other than a quote, or a tab",
      );
    header = bool(m.get("header")!, path + ".header");
    bool(m.get("trim")!, path + ".trim");
  } else if (format === "xml") {
    const nv = m.get("namespaces")!;
    if (!isObj(nv))
      throw new SourceError(
        path + ".namespaces",
        "type",
        `expected object, got ${kindName(nv)}`,
      );
    if (nv.size > 8)
      throw new SourceError(
        path + ".namespaces",
        "limit",
        "at most 8 namespaces",
      );
    for (const [k, x] of nv) {
      if (!isXName(k) || k.includes(":"))
        val(path + ".namespaces", `invalid prefix ${JSON.stringify(k)}`);
      const uri = str(x, `${path}.namespaces.${k}`);
      if (uri === "" || uri.length > 256 || !isPrintable(uri))
        val(
          `${path}.namespaces.${k}`,
          "must be 1 to 256 printable ASCII characters",
        );
      namespaces.add(k);
    }
  } else if (format === "abi") {
    const tv = m.get("types")!;
    if (!Array.isArray(tv))
      throw new SourceError(
        path + ".types",
        "type",
        `expected array, got ${kindName(tv)}`,
      );
    if (tv.length === 0 || tv.length > 8)
      throw new SourceError(path + ".types", "limit", "1 to 8 types");
    types = tv.map((e, i) => {
      try {
        return parseABIType(str(e, `${path}.types[${i}]`));
      } catch (err) {
        if (err instanceof SourceError) throw err;
        return val(`${path}.types[${i}]`, (err as Error).message);
      }
    });
  } else if (format === "layout") {
    const disc = optStr(m.get("discriminator")!, path + ".discriminator");
    if (disc !== null) {
      if (!isHexBytes(disc) || disc.length !== 2 + 16)
        val(
          path + ".discriminator",
          "must be 0x-prefixed lowercase hex of 8 bytes",
        );
      hasDisc = true;
    }
  }

  const fv = m.get("fields")!;
  if (!isObj(fv))
    throw new SourceError(
      path + ".fields",
      "type",
      `expected object, got ${kindName(fv)}`,
    );
  if (fv.size === 0 || fv.size > MAX_FIELDS)
    throw new SourceError(
      path + ".fields",
      "limit",
      `1 to ${MAX_FIELDS} fields`,
    );
  const leaves: string[] = [];
  const layoutFields: { name: string; offset: number; size: number }[] = [];
  for (const [name, f] of fv) {
    if (!isName(name))
      val(
        path + ".fields",
        `field name ${JSON.stringify(name)} must match [A-Za-z_][A-Za-z0-9_]{0,31}`,
      );
    const fp = `${path}.fields.${name}`;
    switch (format) {
      case "json": {
        const fm = exact(f, fp, ["path"]);
        const bad = checkJSONPath(str(fm.get("path"), fp + ".path"));
        if (bad) val(fp + ".path", bad);
        break;
      }
      case "xml": {
        const fm = exact(f, fp, ["path"]);
        const used = new Set<string>();
        const bad = checkXPath(str(fm.get("path"), fp + ".path"), used);
        if (bad) val(fp + ".path", bad);
        for (const p of used)
          if (!namespaces.has(p))
            val(
              fp + ".path",
              `namespace prefix ${JSON.stringify(p)} is not declared in namespaces`,
            );
        break;
      }
      case "text": {
        const fm = exact(f, fp, ["regex"]);
        const re = str(fm.get("regex"), fp + ".regex");
        if (re.length > 256 || !isPrintable(re))
          val(fp + ".regex", "must be at most 256 printable ASCII characters");
        const bad = checkRegex(re);
        if (bad) val(fp + ".regex", bad);
        break;
      }
      case "csv": {
        const fm = exact(f, fp, ["col", "row"]);
        csvCol(fm.get("col")!, fp + ".col", header);
        const rm = exact(fm.get("row")!, fp + ".row", ["index", "match"]);
        const hasIdx = rm.get("index") !== null;
        const hasMatch = rm.get("match") !== null;
        if (hasIdx === hasMatch)
          val(fp + ".row", "give exactly one of index and match");
        if (hasIdx)
          uintField(rm.get("index")!, fp + ".row.index", 0, 1_000_000);
        else {
          const mm = exact(rm.get("match")!, fp + ".row.match", ["col", "eq"]);
          csvCol(mm.get("col")!, fp + ".row.match.col", header);
          if (str(mm.get("eq"), fp + ".row.match.eq").length > 256)
            throw new SourceError(
              fp + ".row.match.eq",
              "limit",
              "at most 256 bytes",
            );
        }
        break;
      }
      case "abi": {
        const fm = exact(f, fp, ["pick"]);
        const bad = checkPick(str(fm.get("pick"), fp + ".pick"), types);
        if (bad) val(fp + ".pick", bad);
        break;
      }
      case "felts": {
        const fm = exact(f, fp, ["at", "view"]);
        uintField(fm.get("at")!, fp + ".at", 0, 255);
        oneOf(fp + ".view", str(fm.get("view"), fp + ".view"), [
          "felt",
          "u256",
          "bool",
          "shortString",
          "i128",
        ]);
        break;
      }
      case "layout": {
        const fm = exact(f, fp, ["offset", "type"]);
        const offset = uintField(fm.get("offset")!, fp + ".offset", 0, 1 << 24);
        const size = layoutSize(str(fm.get("type"), fp + ".type"));
        if (size === null)
          val(
            fp + ".type",
            "must be u8, i8, bool, u16le, i16le, u32le, i32le, u64le, i64le, u128le, i128le, pubkey or bytes[n]",
          );
        layoutFields.push({ name, offset, size: size! });
        break;
      }
    }
    leaves.push(name);
  }
  if (format === "layout" && svm?.dataSlice) {
    const { offset: so, length } = svm.dataSlice;
    const cover = (off: number, n: number, what: string): void => {
      if (off < so || off + n > so + length)
        val(
          path,
          `${what} (bytes ${off} to ${off + n}) is outside dataSlice (bytes ${so} to ${so + length})`,
        );
    };
    if (hasDisc) cover(0, 8, "discriminator");
    for (const f of layoutFields) cover(f.offset, f.size, "field " + f.name);
  }
  return leaves;
}

// ---------------------------------------------------------------------------------------------
// text decoder regular expressions
// ---------------------------------------------------------------------------------------------

/**
 * Unicode classes a `text` regex may use: the general categories. Go's `regexp` also knows scripts and
 * category aliases, but its tables differ between Go versions (the same name is accepted by one node
 * toolchain and rejected by another), so the format admits only names that every version agrees on.
 */
const UNICODE_CATEGORIES = new Set([
  "L",
  "Lu",
  "Ll",
  "Lt",
  "Lm",
  "Lo",
  "M",
  "Mn",
  "Mc",
  "Me",
  "N",
  "Nd",
  "Nl",
  "No",
  "P",
  "Pc",
  "Pd",
  "Ps",
  "Pe",
  "Pi",
  "Pf",
  "Po",
  "S",
  "Sm",
  "Sc",
  "Sk",
  "So",
  "Z",
  "Zs",
  "Zl",
  "Zp",
  "C",
  "Cc",
  "Cf",
  "Co",
  "Cs",
]);
const POSIX_CLASSES = new Set([
  "alnum",
  "alpha",
  "ascii",
  "blank",
  "cntrl",
  "digit",
  "graph",
  "lower",
  "print",
  "punct",
  "space",
  "upper",
  "word",
  "xdigit",
]);

class RegexSyntaxError extends Error {}

interface RNode {
  rep?: { min: number; max: number };
  subs: RNode[];
}
type RItem = { k: "lp" } | { k: "vb" } | { k: "e"; n: RNode };

const isDigit = (c: string | undefined): boolean =>
  c !== undefined && c >= "0" && c <= "9";
const isAlnum = (c: string): boolean => /^[0-9A-Za-z]$/.test(c);
const unhex = (c: string): number =>
  /^[0-9a-fA-F]$/.test(c) ? parseInt(c, 16) : -1;

/** repeatIsValid of Go's regexp/syntax: nested counted repeats may not multiply past n copies. */
function repeatIsValid(re: RNode, n: number): boolean {
  if (re.rep) {
    let m = re.rep.max;
    if (m === 0) return true;
    if (m < 0) m = re.rep.min;
    if (m > n) return false;
    if (m > 0) n = Math.floor(n / m);
  }
  return re.subs.every((sub) => repeatIsValid(sub, n));
}

/**
 * Parses an expression exactly as Go's `regexp.Compile` does (RE2 syntax with the Perl flags), keeping
 * only what decides validity, and returns its number of capture groups. It throws `RegexSyntaxError` for
 * anything Go rejects, and for Unicode classes outside {@link UNICODE_CATEGORIES}. The two are kept in
 * step by the differential test against the Go reference.
 */
function parseRE2(s: string): number {
  const fail = (m: string): never => {
    throw new RegexSyntaxError(m);
  };
  const stack: RItem[] = [];
  let numCap = 0;
  const leaf = (): void => {
    stack.push({ k: "e", n: { subs: [] } });
  };
  const collapse = (): void => {
    let i = stack.length;
    while (i > 0 && stack[i - 1]!.k === "e") i--;
    const subs = stack.splice(i).map((it) => (it as { k: "e"; n: RNode }).n);
    stack.push({ k: "e", n: subs.length === 1 ? subs[0]! : { subs } });
  };
  const swapVerticalBar = (): boolean => {
    const n = stack.length;
    if (n >= 2 && stack[n - 2]!.k === "vb") {
      const top = stack[n - 1]!;
      stack[n - 1] = stack[n - 2]!;
      stack[n - 2] = top;
      return true;
    }
    return false;
  };

  const parseInt10 = (u: string): { n: number; rest: string } | null => {
    if (!isDigit(u[0])) return null;
    if (u.length >= 2 && u[0] === "0" && isDigit(u[1])) return null;
    let j = 0;
    while (j < u.length && isDigit(u[j])) j++;
    let n = 0;
    for (const ch of u.slice(0, j)) {
      if (n >= 1e8) {
        n = -1;
        break;
      }
      n = n * 10 + (ch.charCodeAt(0) - 48);
    }
    return { n, rest: u.slice(j) };
  };
  const parseRepeat = (
    t: string,
  ): { min: number; max: number; rest: string } | null => {
    let u = t.slice(1);
    const a = parseInt10(u);
    if (!a) return null;
    let min = a.n;
    u = a.rest;
    if (u === "") return null;
    let max: number;
    if (u[0] !== ",") max = min;
    else {
      u = u.slice(1);
      if (u === "") return null;
      if (u[0] === "}") max = -1;
      else {
        const b = parseInt10(u);
        if (!b) return null;
        max = b.n;
        u = b.rest;
        if (max < 0) min = -1;
      }
    }
    if (u === "" || u[0] !== "}") return null;
    return { min, max, rest: u.slice(1) };
  };

  const parseEscape = (u: string): { c: number; rest: string } => {
    let t = u.slice(1);
    if (t === "") return fail("trailing backslash at end of expression");
    const ch = t[0]!;
    t = t.slice(1);
    const bad = (): never => fail("invalid escape sequence");
    const octal = (first: number): { c: number; rest: string } => {
      let r = first;
      for (let k = 1; k < 3; k++) {
        if (t === "" || t[0]! < "0" || t[0]! > "7") break;
        r = r * 8 + (t.charCodeAt(0) - 48);
        t = t.slice(1);
      }
      return { c: r, rest: t };
    };
    switch (ch) {
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
        if (t === "" || t[0]! < "0" || t[0]! > "7") return bad();
        return octal(ch.charCodeAt(0) - 48);
      case "0":
        return octal(0);
      case "x": {
        if (t === "") return bad();
        let c = t[0]!;
        t = t.slice(1);
        if (c === "{") {
          let nhex = 0;
          let r = 0;
          for (;;) {
            if (t === "") return bad();
            c = t[0]!;
            t = t.slice(1);
            if (c === "}") break;
            const v = unhex(c);
            if (v < 0) return bad();
            r = r * 16 + v;
            if (r > 0x10ffff) return bad();
            nhex++;
          }
          if (nhex === 0) return bad();
          return { c: r, rest: t };
        }
        const x = unhex(c);
        if (t === "") return bad();
        const y = unhex(t[0]!);
        t = t.slice(1);
        if (x < 0 || y < 0) return bad();
        return { c: x * 16 + y, rest: t };
      }
      case "a":
        return { c: 7, rest: t };
      case "f":
        return { c: 12, rest: t };
      case "n":
        return { c: 10, rest: t };
      case "r":
        return { c: 13, rest: t };
      case "t":
        return { c: 9, rest: t };
      case "v":
        return { c: 11, rest: t };
      default:
        if (ch.charCodeAt(0) < 128 && !isAlnum(ch))
          return { c: ch.charCodeAt(0), rest: t };
        return bad();
    }
  };

  /** A leading `\p{..}` / `\pL`; returns the rest, or null when `u` does not start one. */
  const unicodeClass = (u: string): string | null => {
    if (u.length < 2 || u[0] !== "\\" || (u[1] !== "p" && u[1] !== "P"))
      return null;
    const t = u.slice(2);
    let name: string;
    let rest: string;
    if (t === "") return fail("invalid character class range");
    if (t[0] !== "{") {
      name = t[0]!;
      rest = t.slice(1);
    } else {
      const end = u.indexOf("}");
      if (end < 0) return fail("invalid character class range");
      name = u.slice(3, end);
      rest = u.slice(end + 1);
    }
    if (name.startsWith("^")) name = name.slice(1);
    if (!UNICODE_CATEGORIES.has(name))
      return fail(
        `unsupported Unicode class ${JSON.stringify(name)}: only general categories (L, Lu, Nd, ...) are accepted`,
      );
    return rest;
  };

  const parseClass = (t0: string): string => {
    let t = t0.slice(1);
    if (t[0] === "^") t = t.slice(1);
    let first = true;
    while (t === "" || t[0] !== "]" || first) {
      first = false;
      if (t.length > 2 && t[0] === "[" && t[1] === ":") {
        const idx = t.slice(2).indexOf(":]");
        if (idx >= 0) {
          const inner = t.slice(2, idx + 2);
          if (
            !POSIX_CLASSES.has(inner.startsWith("^") ? inner.slice(1) : inner)
          )
            return fail("invalid character class range");
          t = t.slice(idx + 4);
          continue;
        }
      }
      const uc = unicodeClass(t);
      if (uc !== null) {
        t = uc;
        continue;
      }
      if (t.length >= 2 && t[0] === "\\" && "dDsSwW".includes(t[1]!)) {
        t = t.slice(2);
        continue;
      }
      const classChar = (u: string): { c: number; rest: string } => {
        if (u === "") return fail("missing closing ]");
        if (u[0] === "\\") return parseEscape(u);
        return { c: u.charCodeAt(0), rest: u.slice(1) };
      };
      const lo = classChar(t);
      t = lo.rest;
      if (t.length >= 2 && t[0] === "-" && t[1] !== "]") {
        const h = classChar(t.slice(1));
        t = h.rest;
        if (h.c < lo.c) return fail("invalid character class range");
      }
    }
    return t.slice(1);
  };

  let lastRepeat = false;
  let t = s;
  while (t !== "") {
    let isRepeat = false;
    const op = (
      rep: { min: number; max: number } | null,
      after0: string,
    ): string => {
      let after = after0;
      if (after[0] === "?") after = after.slice(1);
      if (lastRepeat) return fail("invalid nested repetition operator");
      const n = stack.length;
      if (n === 0) return fail("missing argument to repetition operator");
      const top = stack[n - 1]!;
      if (top.k !== "e") return fail("missing argument to repetition operator");
      const node: RNode = rep ? { rep, subs: [top.n] } : { subs: [top.n] };
      stack[n - 1] = { k: "e", n: node };
      if (rep && (rep.min >= 2 || rep.max >= 2) && !repeatIsValid(node, 1000))
        return fail("invalid repeat count");
      return after;
    };
    switch (t[0]) {
      case "(":
        if (t[1] === "?") {
          const startsWithP = t.length > 4 && t[2] === "P" && t[3] === "<";
          const startsWithName = t.length > 3 && t[2] === "<";
          if (startsWithP || startsWithName) {
            const end = t.indexOf(">");
            if (end < 0) return fail("invalid named capture");
            const name = t.slice(startsWithName ? 3 : 4, end);
            if (!/^[A-Za-z0-9_]+$/.test(name))
              return fail("invalid named capture");
            numCap++;
            stack.push({ k: "lp" });
            t = t.slice(end + 1);
            break;
          }
          let u = t.slice(2);
          let sign = 1;
          let sawFlag = false;
          let done = false;
          while (u !== "" && !done) {
            const c = u[0]!;
            u = u.slice(1);
            switch (c) {
              case "i":
              case "m":
              case "s":
              case "U":
                sawFlag = true;
                break;
              case "-":
                if (sign < 0) return fail("invalid or unsupported Perl syntax");
                sign = -1;
                sawFlag = false;
                break;
              case ":":
              case ")":
                if (sign < 0 && !sawFlag)
                  return fail("invalid or unsupported Perl syntax");
                if (c === ":") stack.push({ k: "lp" });
                done = true;
                break;
              default:
                return fail("invalid or unsupported Perl syntax");
            }
          }
          if (!done) return fail("invalid or unsupported Perl syntax");
          t = u;
          break;
        }
        numCap++;
        stack.push({ k: "lp" });
        t = t.slice(1);
        break;
      case "|":
        collapse();
        if (!swapVerticalBar()) stack.push({ k: "vb" });
        t = t.slice(1);
        break;
      case ")": {
        collapse();
        if (swapVerticalBar()) stack.pop();
        collapse();
        const n = stack.length;
        if (n < 2) return fail("unexpected )");
        const re1 = stack[n - 1]!;
        const re2 = stack[n - 2]!;
        stack.length = n - 2;
        if (re2.k !== "lp" || re1.k !== "e") return fail("unexpected )");
        stack.push({ k: "e", n: { subs: [re1.n] } });
        t = t.slice(1);
        break;
      }
      case "^":
      case "$":
      case ".":
        leaf();
        t = t.slice(1);
        break;
      case "[":
        t = parseClass(t);
        leaf();
        break;
      case "*":
      case "+":
      case "?":
        t = op(null, t.slice(1));
        isRepeat = true;
        break;
      case "{": {
        const r = parseRepeat(t);
        if (!r) {
          leaf();
          t = t.slice(1);
          break;
        }
        if (
          r.min < 0 ||
          r.min > 1000 ||
          r.max > 1000 ||
          (r.max >= 0 && r.min > r.max)
        )
          return fail("invalid repeat count");
        t = op({ min: r.min, max: r.max }, r.rest);
        isRepeat = true;
        break;
      }
      case "\\": {
        if (t.length >= 2) {
          const d = t[1]!;
          if (d === "A" || d === "b" || d === "B" || d === "z") {
            leaf();
            t = t.slice(2);
            break;
          }
          if (d === "C") return fail("invalid escape sequence");
          if (d === "Q") {
            const rest = t.slice(2);
            const idx = rest.indexOf("\\E");
            const lit = idx < 0 ? rest : rest.slice(0, idx);
            for (let k = 0; k < lit.length; k++) leaf();
            t = idx < 0 ? "" : rest.slice(idx + 2);
            break;
          }
        }
        const uc = unicodeClass(t);
        if (uc !== null) {
          leaf();
          t = uc;
          break;
        }
        if (t.length >= 2 && "dDsSwW".includes(t[1]!)) {
          leaf();
          t = t.slice(2);
          break;
        }
        const e = parseEscape(t);
        leaf();
        t = e.rest;
        break;
      }
      default:
        leaf();
        t = t.slice(1);
    }
    lastRepeat = isRepeat;
  }
  collapse();
  if (swapVerticalBar()) stack.pop();
  collapse();
  if (stack.length !== 1) return fail("missing closing )");
  return numCap;
}

/** Why `re` is not an acceptable `text` regex (valid RE2, exactly one capture group), or null. */
function checkRegex(re: string): string | null {
  let groups: number;
  try {
    groups = parseRE2(re);
  } catch (e) {
    if (e instanceof RegexSyntaxError)
      return `not a valid RE2 expression: ${e.message}`;
    throw e;
  }
  return groups === 1
    ? null
    : `must have exactly one capture group, has ${groups}`;
}

function csvCol(v: Json, path: string, header: boolean): void {
  const s = str(v, path);
  if (header) {
    if (s === "" || s.length > 64 || !isPrintable(s))
      val(path, "must be a header name of 1 to 64 printable ASCII characters");
    return;
  }
  if (parseUint(s, 1024) === null)
    val(path, "must be a column index when header is false");
}

function checkFinality(v: Json, path: string, kind: string): void {
  const m = exact(v, path, ["lagMs", "mode", "n"]);
  const mode = str(m.get("mode"), path + ".mode");
  oneOf(
    path + ".mode",
    mode,
    kind === "starknet"
      ? ["finalized", "confirmations"]
      : ["finalized", "safe", "confirmations"],
  );
  const lag = uintField(m.get("lagMs")!, path + ".lagMs", 0, 7 * 86_400_000);
  if (lag % 1000 !== 0)
    val(
      path + ".lagMs",
      "must be a multiple of 1000: chains are read at a whole second",
    );
  if (mode === "confirmations") uintField(m.get("n")!, path + ".n", 1, 1000);
  else if (m.get("n") !== null)
    val(path + ".n", "must be null unless mode is confirmations");
}

function checkInput(name: string, v: Json, path: string): InputInfo {
  if (!isObj(v))
    throw new SourceError(path, "type", `expected object, got ${kindName(v)}`);
  if (!v.has("kind"))
    throw new SourceError(path + ".kind", "missing_key", "missing key");
  const kind = str(v.get("kind"), path + ".kind");
  switch (kind) {
    case "http": {
      const m = exact(v, path, ["decode", "kind", "read"]);
      checkHTTPRead(m.get("read")!, path + ".read");
      return {
        kind,
        leaves: checkDecode(m.get("decode")!, path + ".decode", kind, null),
      };
    }
    case "evm":
    case "starknet": {
      const m = exact(v, path, ["chain", "decode", "finality", "kind", "read"]);
      const chain = str(m.get("chain"), path + ".chain");
      if (!CAIP[kind]!.test(chain))
        val(path + ".chain", `must be a CAIP-2 id for a ${kind} chain`);
      checkFinality(m.get("finality")!, path + ".finality", kind);
      if (kind === "evm") checkEVMRead(m.get("read")!, path + ".read");
      else checkStarknetRead(m.get("read")!, path + ".read");
      return {
        kind,
        leaves: checkDecode(m.get("decode")!, path + ".decode", kind, null),
      };
    }
    case "svm": {
      const m = exact(v, path, [
        "chain",
        "commitment",
        "decode",
        "kind",
        "maxAgeMs",
        "read",
      ]);
      const chain = str(m.get("chain"), path + ".chain");
      if (!CAIP.svm!.test(chain))
        val(path + ".chain", "must be a CAIP-2 id for a svm chain");
      oneOf(
        path + ".commitment",
        str(m.get("commitment"), path + ".commitment"),
        ["finalized", "confirmed"],
      );
      uintField(m.get("maxAgeMs")!, path + ".maxAgeMs", 1, 86_400_000);
      const info = checkSVMRead(m.get("read")!, path + ".read");
      return {
        kind,
        leaves: checkDecode(m.get("decode")!, path + ".decode", kind, info),
      };
    }
  }
  return val(path + ".kind", "must be one of http, evm, starknet, svm");
}

function checkAggregation(v: Json): boolean {
  if (v === null) return false;
  const m = exact(v, "aggregation", [
    "maxAgeMs",
    "maxDeviationBps",
    "mode",
    "rule",
  ]);
  oneOf("aggregation.mode", str(m.get("mode"), "aggregation.mode"), [
    "tolerance",
  ]);
  oneOf("aggregation.rule", str(m.get("rule"), "aggregation.rule"), ["median"]);
  uintField(m.get("maxAgeMs")!, "aggregation.maxAgeMs", 1, 86_400_000);
  uintField(
    m.get("maxDeviationBps")!,
    "aggregation.maxDeviationBps",
    0,
    10_000,
  );
  return true;
}

export const OUTPUT_TYPES = [
  "int256",
  "uint256",
  "bool",
  "bytes32",
  "string32",
  "keccak256",
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

function checkOutput(v: Json): { type: OutputType; decimals: number } {
  const m = exact(v, "output", ["decimals", "type"]);
  const type = str(m.get("type"), "output.type");
  oneOf("output.type", type, [...OUTPUT_TYPES]);
  if (type === "int256" || type === "uint256") {
    return {
      type,
      decimals: uintField(
        m.get("decimals")!,
        "output.decimals",
        0,
        MAX_OUTPUT_DECIMALS,
      ),
    };
  }
  if (m.get("decimals") !== null)
    val("output.decimals", `must be null for output type ${type}`);
  return { type: type as OutputType, decimals: 0 };
}

/** A validated source: its canonical form and ID, and the plain document. */
export interface ParsedSource {
  /** The document, exactly as given (every key present). */
  doc: SourceDoc;
  /** Canonical JSON text; its UTF-8 bytes are what the ID hashes and what nodes receive. */
  canonical: string;
  bytes: Uint8Array;
  /** keccak256 of `bytes`. */
  id: Uint8Array;
  /** `0x`-prefixed lowercase hex of `id`. */
  idHex: string;
  inputNames: string[];
  output: { type: OutputType; decimals: number };
  tolerance: boolean;
}

function build(v: Json, maxCanonical: number): ParsedSource {
  const m = exact(v, "", [
    "aggregation",
    "assert",
    "inputs",
    "output",
    "transform",
    "v",
  ]);
  const ver = str(m.get("v"), "v");
  if (ver !== SOURCE_VERSION)
    val("v", `unsupported version ${JSON.stringify(ver)}`);

  const iv = m.get("inputs")!;
  if (!isObj(iv))
    throw new SourceError(
      "inputs",
      "type",
      `expected object, got ${kindName(iv)}`,
    );
  if (iv.size === 0 || iv.size > MAX_INPUTS)
    throw new SourceError(
      "inputs",
      "limit",
      `a source has 1 to ${MAX_INPUTS} inputs`,
    );
  const leaves = new Set<string>();
  const names: string[] = [];
  let chainInputs = 0;
  for (const [name, x] of iv) {
    if (!isName(name))
      val(
        "inputs",
        `input name ${JSON.stringify(name)} must match [A-Za-z_][A-Za-z0-9_]{0,31}`,
      );
    const info = checkInput(name, x, "inputs." + name);
    if (info.kind !== "http") chainInputs++;
    for (const l of info.leaves) leaves.add(`${name}.${l}`);
    names.push(name);
  }
  names.sort();

  const output = checkOutput(m.get("output")!);
  const tolerance = checkAggregation(m.get("aggregation")!);
  if (tolerance && output.type !== "int256")
    val(
      "aggregation",
      `tolerance aggregation needs output.type int256, got ${JSON.stringify(output.type)}`,
    );

  const ctx: ExprCtx = {
    leaves,
    allowOut: false,
    allowBlock: chainInputs === 1,
    nodes: { n: 0 },
  };
  checkExpr(m.get("transform")!, "transform", ctx, 1);
  const av = m.get("assert")!;
  if (!Array.isArray(av))
    throw new SourceError(
      "assert",
      "type",
      `expected array, got ${kindName(av)}`,
    );
  if (av.length > MAX_ASSERTS)
    throw new SourceError(
      "assert",
      "limit",
      `at most ${MAX_ASSERTS} assertions`,
    );
  ctx.allowOut = true;
  av.forEach((a, i) => checkExpr(a, `assert[${i}]`, ctx, 1));

  const canonical = canonicalJson(v);
  const bytes = enc.encode(canonical);
  if (bytes.length > maxCanonical)
    throw new SourceError(
      "",
      "limit",
      `canonical form is ${bytes.length} bytes, over the ${maxCanonical} byte limit`,
    );
  const id = keccak_256(bytes);
  return {
    doc: toPlain(v) as SourceDoc,
    canonical,
    bytes,
    id,
    idHex: "0x" + toHex(id),
    inputNames: names,
    output,
    tolerance,
  };
}

function parseWith(
  input: string | Uint8Array | object,
  maxCanonical: number,
): ParsedSource {
  let v: Json;
  if (typeof input === "string" || input instanceof Uint8Array) {
    const len =
      typeof input === "string" ? enc.encode(input).length : input.length;
    if (len > MAX_RAW_BYTES)
      throw new SourceError(
        "",
        "limit",
        `source is ${len} bytes, over the ${MAX_RAW_BYTES} byte parse limit`,
      );
    v = parseStrict(input);
  } else {
    v = fromPlain(input);
  }
  return build(v, maxCanonical);
}

/** Validate a source given as JSON text, bytes or a plain object, in any key order and whitespace. */
export function parseSource(input: string | Uint8Array | object): ParsedSource {
  return parseWith(input, MAX_CANONICAL_BYTES);
}

/** {@link parseSource} for a decrypted private source, whose filled-in secrets may make it longer. */
export function parsePrivateSource(
  input: string | Uint8Array | object,
): ParsedSource {
  return parseWith(input, MAX_PRIVATE_BYTES);
}

/** Like {@link parseSource}, and also requires the input to be the canonical form already. */
export function parseCanonicalSource(input: string | Uint8Array): ParsedSource {
  const s = parseWith(input, MAX_CANONICAL_BYTES);
  const text =
    typeof input === "string" ? input : new TextDecoder().decode(input);
  if (text !== s.canonical)
    throw new SourceError(
      "",
      "noncanonical",
      "source bytes are not in canonical form",
    );
  return s;
}

/** The source ID of a source document: keccak256 of its canonical bytes. */
export function deriveSourceId(
  input: string | Uint8Array | object,
): Uint8Array {
  return parseSource(input).id;
}

/** {@link deriveSourceId} as `0x`-prefixed hex. */
export function deriveSourceIdHex(input: string | Uint8Array | object): string {
  return parseSource(input).idHex;
}

// ---------------------------------------------------------------------------------------------
// Chain list
// ---------------------------------------------------------------------------------------------

export type { Chain };

/**
 * Check a source's chain inputs against the chain list: each chain must be listed, of the right
 * kind, offer the finality mode or commitment, and keep `lagMs` or `maxAgeMs` within its bounds. A
 * source that no node could ever satisfy is refused here, not as a failed round.
 */
export function checkChains(
  src: ParsedSource,
  list: Chain[] = CHAIN_LIST,
  allow?: (chain: string) => boolean,
): void {
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const name of src.inputNames) {
    const input = (src.doc.inputs as Record<string, any>)[name];
    if (input.kind === "http") continue;
    const path = "inputs." + name;
    const c = byId.get(input.chain);
    if (!c || (allow && !allow(input.chain)))
      throw new SourceError(
        path + ".chain",
        "value",
        `chain ${input.chain} is not supported`,
      );
    if (c.kind !== input.kind)
      throw new SourceError(
        path + ".chain",
        "value",
        `chain ${input.chain} is a ${c.kind} chain, not ${input.kind}`,
      );
    if (input.kind === "svm") {
      const b = c.commitments?.[input.commitment];
      if (!b)
        throw new SourceError(
          path + ".commitment",
          "value",
          `chain ${input.chain} does not offer commitment "${input.commitment}"`,
        );
      const maxAge = Number(input.maxAgeMs);
      if (maxAge < b.minMaxAgeMs || maxAge > (c.maxMaxAgeMs ?? 0)) {
        throw new SourceError(
          path + ".maxAgeMs",
          "value",
          `must be between ${b.minMaxAgeMs} and ${c.maxMaxAgeMs} for ${input.chain} at ${input.commitment}`,
        );
      }
      continue;
    }
    const fin = input.finality;
    const b = c.finality?.[fin.mode];
    if (!b)
      throw new SourceError(
        path + ".finality.mode",
        "value",
        `chain ${input.chain} does not offer finality "${fin.mode}"`,
      );
    let minLag = b.minLagMs ?? 0;
    if (fin.mode === "confirmations") {
      const n = Number(fin.n);
      if (n < 1 || n > (b.maxN ?? 0))
        throw new SourceError(
          path + ".finality.n",
          "value",
          `must be between 1 and ${b.maxN} for ${input.chain}`,
        );
      minLag = Math.ceil(((n + 2) * (c.blockTimeMs ?? 0)) / 1000) * 1000;
    }
    const lag = Number(fin.lagMs);
    if (lag < minLag || lag > (c.maxLagMs ?? 0)) {
      throw new SourceError(
        path + ".finality.lagMs",
        "value",
        `must be between ${minLag} and ${c.maxLagMs} for ${input.chain} at ${fin.mode}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Types for building sources
// ---------------------------------------------------------------------------------------------

/** An expression of the transform tree. */
export type Expr =
  | { ref: string }
  | { const: string }
  | { str: string }
  | { bytes: string }
  | { bool: boolean }
  | { op: string; args: Expr[]; [param: string]: unknown };

export interface OutputDoc {
  type: OutputType;
  decimals: string | null;
}
export interface AggregationDoc {
  mode: "tolerance";
  rule: "median";
  maxDeviationBps: string;
  maxAgeMs: string;
}

/** A source document in its canonical shape: every key present, every number a string. */
export interface SourceDoc {
  v: "1";
  inputs: Record<string, any>;
  transform: Expr;
  assert: Expr[];
  output: OutputDoc;
  aggregation: AggregationDoc | null;
}

/** Whether the source declares keccak256 output (its signed value is a hash of a preimage). */
export const hasPreimage = (src: ParsedSource): boolean =>
  src.output.type === "keccak256";

/** Everything {@link parseSource} computes, for a source that was already validated. */
export function encodeSourceBytes(src: ParsedSource): Uint8Array {
  return src.bytes;
}

/** The ID of canonical source bytes: keccak256. */
export function sourceIdOf(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

export { CHAIN_LIST };
