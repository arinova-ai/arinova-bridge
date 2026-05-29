import { describe, expect, it, vi } from "vitest";
import { buildJobReportContent, clearTrackedInterval, clearTrackedTimeout } from "../../../src/jobs/lifecycle.js";

describe("job lifecycle helpers", () => {
  it("builds spawn and fork parent report content with truncation", () => {
    const longResult = "x".repeat(2005);

    expect(
      buildJobReportContent({
        kind: "spawn",
        id: "sp-1",
        targetAgent: "pan",
        status: "completed",
        result: "done",
      }),
    ).toBe("[spawn:sp-1 from:pan] 完成\ndone");

    const forkReport = buildJobReportContent({
      kind: "fork",
      id: "fk-1",
      status: "failed",
      result: longResult,
    });
    expect(forkReport).toMatch(/^\[fork:fk-1\] 失敗\n/);
    expect(forkReport).toContain("\n...(truncated)");
    expect(forkReport.length).toBe("[fork:fk-1] 失敗\n".length + 2000 + "\n...(truncated)".length);
  });

  it("clears tracked timeout and interval entries", () => {
    vi.useFakeTimers();
    try {
      const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
      const intervals = new Map<string, ReturnType<typeof setInterval>>();
      timeouts.set(
        "job-1",
        setTimeout(() => {}, 1000),
      );
      intervals.set(
        "job-1",
        setInterval(() => {}, 1000),
      );

      expect(clearTrackedTimeout("job-1", timeouts)).toBe(true);
      expect(clearTrackedTimeout("missing", timeouts)).toBe(false);
      expect(clearTrackedInterval("job-1", intervals)).toBe(true);
      expect(clearTrackedInterval("missing", intervals)).toBe(false);
      expect(timeouts.size).toBe(0);
      expect(intervals.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
