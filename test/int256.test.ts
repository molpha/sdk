import { describe, expect, it } from "vitest";
import { bytesToHex } from "../src/core/encoding.js";
import {
  INT256_MAX,
  INT256_MIN,
  decodeInt256,
  encodeInt256,
  encodeInt256Decimal,
  formatInt256Decimal,
} from "../src/core/int256.js";

/**
 * Vectors generated with the node's own `new/tolerance` package (Encode / Decode / Format,
 * molpha-node-client af9144e), run with Go 1.26 against the repository source.
 */
const GO_VECTORS: Array<[input: string, decimals: number, hex: string, int: string, text: string]> = [
  ["1.005", 2, "64", "100", "1"],
  ["1.015", 2, "66", "102", "1.02"],
  ["-1.005", 2, "ff".repeat(31) + "9c", "-100", "-1"],
  ["-1.015", 2, "ff".repeat(31) + "9a", "-102", "-1.02"],
  ["0.000000005", 8, "00", "0", "0"],
  ["0.000000015", 8, "02", "2", "0.00000002"],
  ["-1", 0, "ff".repeat(32), "-1", "-1"],
  ["42150.12345678", 8, "03d56250474e", "4215012345678", "42150.12345678"],
  ["-0.5", 0, "00", "0", "0"],
  ["0.5", 0, "00", "0", "0"],
  ["1.5", 0, "02", "2", "2"],
  ["2.5", 0, "02", "2", "2"],
  ["-2.5", 0, "ff".repeat(31) + "fe", "-2", "-2"],
  ["+7", 3, "1b58", "7000", "7"],
  ["007.10", 4, "011558", "71000", "7.1"],
  ["0", 8, "00", "0", "0"],
  ["-0", 8, "00", "0", "0"],
  ["-0.000000001", 8, "00", "0", "0"],
  ["123", 0, "7b", "123", "123"],
  ["0.9999", 0, "01", "1", "1"],
];

const word = (hexTail: string): string => hexTail.padStart(64, "0");

describe("encodeInt256Decimal", () => {
  it.each(GO_VECTORS)("%s @%i matches the node encoder", (input, decimals, hex, int, text) => {
    const bytes = encodeInt256Decimal(input, decimals);
    expect(bytes).toHaveLength(32);
    expect(bytesToHex(bytes)).toBe(hex.length === 64 ? hex : word(hex));
    expect(decodeInt256(bytes).toString()).toBe(int);
    expect(formatInt256Decimal(bytes, decimals)).toBe(text);
  });

  it("rounds half to even on the magnitude", () => {
    const at = (s: string, d: number) => decodeInt256(encodeInt256Decimal(s, d));
    expect(at("1.005", 2)).toBe(100n); // tie, 100 is even
    expect(at("1.015", 2)).toBe(102n); // tie, 101 is odd -> up
    expect(at("-1.005", 2)).toBe(-100n);
    expect(at("-1.015", 2)).toBe(-102n);
    expect(at("1.0051", 2)).toBe(101n); // above the tie
  });

  it("accepts the int256 bounds and rejects one past them", () => {
    expect(bytesToHex(encodeInt256Decimal(INT256_MAX.toString(), 0))).toBe("7f" + "ff".repeat(31));
    expect(bytesToHex(encodeInt256Decimal(INT256_MIN.toString(), 0))).toBe("80" + "00".repeat(31));
    expect(() => encodeInt256Decimal((INT256_MAX + 1n).toString(), 0)).toThrow(/int256 overflow/);
    expect(() => encodeInt256Decimal((INT256_MIN - 1n).toString(), 0)).toThrow(/int256 overflow/);
    expect(() => encodeInt256Decimal("100", 255)).toThrow(/int256 overflow/); // node: 100e255
  });

  it.each(["", "1e3", "NaN", "1.2.3", " 1", "1 ", "0x10", ".5", "5.", "-", "+", "--1", "+-1", "1_0", "١٢", "Infinity"])(
    "rejects invalid decimal %j",
    (input) => {
      expect(() => encodeInt256Decimal(input, 8)).toThrow(/invalid decimal/);
    },
  );

  it("caps the input size and validates decimals", () => {
    expect(() => encodeInt256Decimal("1".repeat(10_001), 0)).toThrow(/decimal too long/);
    expect(() => encodeInt256Decimal("1", -1)).toThrow(RangeError);
    expect(() => encodeInt256Decimal("1", 256)).toThrow(RangeError);
    expect(() => encodeInt256Decimal("1", 1.5)).toThrow(RangeError);
    expect(() => encodeInt256Decimal(1 as unknown as string, 0)).toThrow(/invalid decimal/);
  });
});

describe("encodeInt256 / decodeInt256", () => {
  it("round-trips across the range", () => {
    for (const v of [0n, 1n, -1n, 42n, -42n, 2n ** 128n, -(2n ** 128n), INT256_MAX, INT256_MIN]) {
      expect(decodeInt256(encodeInt256(v))).toBe(v);
    }
  });

  it("uses two's complement big-endian words", () => {
    expect(bytesToHex(encodeInt256(-1n))).toBe("ff".repeat(32));
    expect(bytesToHex(encodeInt256(1n))).toBe("00".repeat(31) + "01");
    expect(decodeInt256("ff".repeat(32))).toBe(-1n);
    expect(decodeInt256("0x" + "00".repeat(31) + "2a")).toBe(42n);
    expect(decodeInt256("80" + "00".repeat(31))).toBe(INT256_MIN);
  });

  it("rejects out-of-range values and non-32-byte inputs", () => {
    expect(() => encodeInt256(INT256_MAX + 1n)).toThrow(/overflow/);
    expect(() => encodeInt256(INT256_MIN - 1n)).toThrow(/overflow/);
    expect(() => decodeInt256("00".repeat(31))).toThrow(/expected 32 bytes/);
    expect(() => decodeInt256(new Uint8Array(33))).toThrow(/expected 32 bytes/);
  });
});

describe("formatInt256Decimal", () => {
  it("renders at the source's scale with trimmed trailing zeros", () => {
    expect(formatInt256Decimal(encodeInt256(100n), 2)).toBe("1");
    expect(formatInt256Decimal(encodeInt256(-100n), 2)).toBe("-1");
    expect(formatInt256Decimal(encodeInt256(5n), 8)).toBe("0.00000005");
    expect(formatInt256Decimal(encodeInt256(-5n), 8)).toBe("-0.00000005");
    expect(formatInt256Decimal(encodeInt256(0n), 8)).toBe("0");
    expect(formatInt256Decimal(encodeInt256(1200n), 3)).toBe("1.2");
    expect(formatInt256Decimal(encodeInt256(-1200n), 3)).toBe("-1.2");
    expect(formatInt256Decimal(encodeInt256(12n), 0)).toBe("12");
    expect(formatInt256Decimal(encodeInt256(INT256_MIN), 0)).toBe(INT256_MIN.toString());
    expect(formatInt256Decimal(encodeInt256(INT256_MIN), 18)).toBe(
      "-57896044618658097711785492504343953926634992332820282019728.792003956564819968",
    );
  });

  it("accepts a decoded bigint and bounds-checks it", () => {
    expect(formatInt256Decimal(-150000000n, 8)).toBe("-1.5");
    expect(() => formatInt256Decimal(INT256_MAX + 1n, 0)).toThrow(/overflow/);
  });

  it("accepts hex input and validates decimals", () => {
    expect(formatInt256Decimal("00".repeat(31) + "2a", 0)).toBe("42");
    expect(() => formatInt256Decimal("00".repeat(32), 256)).toThrow(RangeError);
  });
});
