import { describe, expect, it } from "vitest";
import { SELECTION_WINDOW_MS } from "../src/core/selection.js";
import { ROUND_TICK_MS, timestampAgeSeconds, timestampSeconds } from "../src/core/timestamp.js";
import * as sdk from "../src/index.js";

describe("ROUND_TICK_MS", () => {
  it("is the protocol's 100 ms round tick", () => {
    expect(ROUND_TICK_MS).toBe(100);
    expect(sdk.ROUND_TICK_MS).toBe(100);
  });

  it("divides the selection window: every second holds exactly ten ticks", () => {
    expect(SELECTION_WINDOW_MS % BigInt(ROUND_TICK_MS)).toBe(0n);
    expect(SELECTION_WINDOW_MS / BigInt(ROUND_TICK_MS)).toBe(10n);
  });
});

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
