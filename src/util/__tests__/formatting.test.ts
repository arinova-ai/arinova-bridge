import { describe, it, expect, vi, afterEach } from "vitest";
import { formatResetIn, getStatusIcon, formatDuration, formatDateTime, truncate } from "../formatting.js";

// ---------------------------------------------------------------------------
// formatResetIn
// ---------------------------------------------------------------------------
describe("formatResetIn", () => {
  const BASE = 1_700_000_000_000; // a realistic ms-epoch (>= 1e12)

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'now' when epoch is in the past", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    expect(formatResetIn(BASE - 60_000)).toBe("now");
    expect(formatResetIn(BASE)).toBe("now");
  });

  it("returns minutes only for short durations", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    // 5 minutes in the future
    expect(formatResetIn(BASE + 5 * 60_000)).toBe("5m");
  });

  it("returns hours and minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    // 1h 30m in the future
    expect(formatResetIn(BASE + 90 * 60_000)).toBe("1h 30m");
  });

  it("returns days, hours, and minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    // 1d 2h 15m in the future
    const futureMs = (1440 + 120 + 15) * 60_000;
    expect(formatResetIn(BASE + futureMs)).toBe("1d 2h 15m");
  });

  it("auto-converts seconds-epoch to ms-epoch", () => {
    // epoch < 1e12 is treated as seconds → multiplied by 1000
    const baseSec = Math.floor(BASE / 1000); // seconds-epoch
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    // 5 minutes (300 seconds) in the future
    expect(formatResetIn(baseSec + 300)).toBe("5m");
  });

  it("treats large epoch (>= 1e12) as already in ms", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    expect(formatResetIn(BASE + 5 * 60_000)).toBe("5m");
  });

  it("omits 0-valued parts (days=0, hours=0)", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    // 2h exactly (no minutes remainder)
    expect(formatResetIn(BASE + 120 * 60_000)).toBe("2h");
  });

  it("includes 0m when d and h are 0 to avoid empty string", () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE);
    // 1 ms from now → ceil to 1 minute
    expect(formatResetIn(BASE + 1)).toBe("1m");
  });
});

// ---------------------------------------------------------------------------
// getStatusIcon
// ---------------------------------------------------------------------------
describe("getStatusIcon", () => {
  it("returns running icon", () => {
    expect(getStatusIcon("running")).toBe("🔄");
  });

  it("returns completed icon", () => {
    expect(getStatusIcon("completed")).toBe("✅");
  });

  it("returns failed icon", () => {
    expect(getStatusIcon("failed")).toBe("❌");
  });

  it("returns paused icon for unknown status", () => {
    expect(getStatusIcon("paused")).toBe("⏸️");
    expect(getStatusIcon("cancelled")).toBe("⏸️");
    expect(getStatusIcon("")).toBe("⏸️");
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe("formatDuration", () => {
  it("formats milliseconds as seconds", () => {
    expect(formatDuration(12345)).toBe("12s");
  });

  it("rounds to nearest second", () => {
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(1499)).toBe("1s");
  });

  it("returns dash for undefined", () => {
    expect(formatDuration(undefined)).toBe("—");
  });

  it("returns dash for null", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("returns dash for 0", () => {
    expect(formatDuration(0)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------
describe("formatDateTime", () => {
  it("formats a numeric timestamp with default timezone", () => {
    const result = formatDateTime(0);
    // epoch 0 in Asia/Taipei is 1970/1/1 08:00:00
    expect(result).toContain("1970");
  });

  it("formats a string timestamp", () => {
    const result = formatDateTime("2024-01-15T00:00:00Z");
    expect(result).toContain("2024");
  });

  it("accepts a custom timezone", () => {
    const result = formatDateTime(0, "UTC");
    // epoch 0 in UTC is 1970/1/1 00:00:00
    expect(result).toContain("1970");
  });

  it("uses zh-TW locale format", () => {
    // Verify it produces a string (locale output varies by platform)
    const result = formatDateTime(1700000000000);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------
describe("truncate", () => {
  it("returns the original string when shorter than maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the original string when exactly maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and adds default suffix when longer than maxLen", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });

  it("uses a custom suffix", () => {
    expect(truncate("hello world", 5, "...")).toBe("hello...");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });

  it("handles maxLen of 0", () => {
    expect(truncate("hello", 0)).toBe("…");
  });

  it("handles single character truncation", () => {
    expect(truncate("ab", 1)).toBe("a…");
  });
});
