import { describe, expect, it } from "vitest";
import { timestampAgeSeconds, timestampSeconds } from "../src/core/timestamp.js";

describe("timestampSeconds", () => {
  it("floors unix milliseconds to whole seconds", () => {
    expect(timestampSeconds(1_700_000_000_000)).toBe(1_700_000_000);
    expect(timestampSeconds(1_700_000_000_999)).toBe(1_700_000_000);
    expect(timestampSeconds(1_700_000_001_000n)).toBe(1_700_000_001);
  });

  it("rejects a negative timestamp", () => {
    expect(() => timestampSeconds(-1)).toThrow(RangeError);
  });
});

describe("timestampAgeSeconds", () => {
  it("is the whole-second age against a seconds clock", () => {
    expect(timestampAgeSeconds(1_700_000_000_500, 1_700_000_010)).toBe(10);
  });

  it("saturates at zero for a timestamp slightly ahead of the local clock", () => {
    expect(timestampAgeSeconds(1_700_000_001_900, 1_700_000_000)).toBe(0);
  });
});
