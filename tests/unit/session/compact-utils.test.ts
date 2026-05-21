import { describe, it, expect } from "vitest";
import {
  buildCompactPrompt,
  getSummaryMaxTokens,
} from "../../../src/session/bridge-session.js";

// ---------------------------------------------------------------------------
// getSummaryMaxTokens — dynamic token budget: 5% of context window, min 500, max 2000
// ---------------------------------------------------------------------------

describe("getSummaryMaxTokens", () => {
  it("returns 2000 for large-context models (1M window × 5% = 50000 → clamped)", () => {
    // All 1M-window models should hit the 2000 cap
    expect(getSummaryMaxTokens("claude-opus-4-6")).toBe(2000);
    expect(getSummaryMaxTokens("gpt-4.1-mini")).toBe(2000);
    expect(getSummaryMaxTokens("gpt-4.1-nano")).toBe(2000);
  });

  it("returns clamped value for 200k-context models (200000 × 5% = 10000 → 2000)", () => {
    expect(getSummaryMaxTokens("claude-sonnet-4-6")).toBe(2000);
    expect(getSummaryMaxTokens("claude-haiku-4-5")).toBe(2000);
  });

  it("uses DEFAULT_CONTEXT_WINDOW (200k) when model is undefined", () => {
    // 200000 × 0.05 = 10000 → clamped to 2000
    expect(getSummaryMaxTokens(undefined)).toBe(2000);
  });

  it("uses DEFAULT_CONTEXT_WINDOW for unknown models", () => {
    // Unknown model falls through to default 200k → 2000
    expect(getSummaryMaxTokens("totally-unknown-model")).toBe(2000);
  });

  it("uses prefix fallback for partial model match (model longer than key)", () => {
    // "gpt-4.1-mini-2025" should match "gpt-4.1-mini" prefix → 1M → 2000
    expect(getSummaryMaxTokens("gpt-4.1-mini-2025")).toBe(2000);
  });

  it("uses reverse prefix fallback (key longer than model)", () => {
    // "gpt-4.1" is a prefix of "gpt-4.1-mini" key → 1M → 2000
    expect(getSummaryMaxTokens("gpt-4.1")).toBe(2000);
  });

  it("never goes below 500", () => {
    // With current model windows (all >= 200k), min won't trigger,
    // but the formula guarantees: Math.max(500, ...)
    const result = getSummaryMaxTokens("claude-opus-4-6");
    expect(result).toBeGreaterThanOrEqual(500);
  });

  it("never exceeds 2000", () => {
    const result = getSummaryMaxTokens("claude-opus-4-6");
    expect(result).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// buildCompactPrompt — auto-detects task vs conversation style
// ---------------------------------------------------------------------------

describe("buildCompactPrompt", () => {
  // ── Task-oriented detection ──

  it("detects task mode when conversation contains commit hashes", () => {
    const text = "user: fixed the bug in commit a1b2c3d";
    const prompt = buildCompactPrompt(text, 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
    expect(prompt).toContain("commit hashes");
    expect(prompt).toContain("## Active Task");
    expect(prompt).toContain("## Key Decisions");
    expect(prompt).toContain("## Modified Files");
    expect(prompt).toContain("## Pending");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("Token budget: 1000 tokens max");
    expect(prompt).toContain(text);
  });

  it("detects task mode when conversation contains UUID card IDs", () => {
    const text = "user: 卡片 ID: bd4921d5-9511-46d7-be56-ee33b5f425c0";
    const prompt = buildCompactPrompt(text, 750);
    expect(prompt).toContain("Summarise this engineering conversation");
    expect(prompt).toContain("card/ticket IDs");
  });

  it("detects task mode when conversation contains code blocks", () => {
    const text = "user: here is the code\n```\nconsole.log('hi')\n```";
    const prompt = buildCompactPrompt(text, 800);
    expect(prompt).toContain("Summarise this engineering conversation");
  });

  it("detects task mode with engineering keywords (commit, merge, deploy, PR, review, bug, fix, feat)", () => {
    for (const keyword of ["commit", "merge", "deploy", "PR", "review", "bug", "fix", "feat"]) {
      const text = `user: we need to ${keyword} this`;
      const prompt = buildCompactPrompt(text, 500);
      expect(prompt).toContain("Summarise this engineering conversation");
    }
  });

  // ── General conversation mode ──

  it("uses general mode for plain conversation without task markers", () => {
    const text = "user: 你好嗎\nassistant: 我很好，謝謝";
    const prompt = buildCompactPrompt(text, 600);
    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).toContain("## 重點摘要");
    expect(prompt).toContain("## 決策紀錄");
    expect(prompt).toContain("## 待辦事項");
    expect(prompt).toContain("Token budget: 600 tokens max");
    expect(prompt).toContain(text);
  });

  // ── Existing summary handling ──

  it("task mode: includes existing summary as 'Previous summary' section", () => {
    const text = "user: fixed commit abc1234";
    const existingSummary = "Prior work: setup complete";
    const prompt = buildCompactPrompt(text, 1000, existingSummary);
    expect(prompt).toContain("Previous summary:");
    expect(prompt).toContain(existingSummary);
    expect(prompt).toContain("New messages:");
    expect(prompt).toContain(text);
  });

  it("task mode: without existing summary uses 'Conversation' section", () => {
    const text = "user: deploy to prod";
    const prompt = buildCompactPrompt(text, 1000);
    expect(prompt).toContain("Conversation:");
    expect(prompt).toContain(text);
    expect(prompt).not.toContain("Previous summary:");
  });

  it("general mode: includes existing summary as merge prompt", () => {
    const text = "user: 今天天氣如何";
    const existingSummary = "之前討論了旅行計畫";
    const prompt = buildCompactPrompt(text, 800, existingSummary);
    expect(prompt).toContain("先前摘要:");
    expect(prompt).toContain(existingSummary);
    expect(prompt).toContain("後續對話:");
    expect(prompt).toContain(text);
  });

  it("general mode: without existing summary uses direct instruction", () => {
    const text = "user: 推薦一本書";
    const prompt = buildCompactPrompt(text, 700);
    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).not.toContain("先前摘要:");
  });

  // ── All compact paths use buildCompactPrompt consistently ──

  it("compact prompt + token budget integration: task mode with compactModel", () => {
    // Simulates the shared logic across Chat auto-compact, /compact, and A2A compact
    const compactModel = "gpt-4.1-nano";
    const tokenBudget = getSummaryMaxTokens(compactModel);
    const messages = [
      { role: "user", content: "fix bug in commit a1b2c3d, card ID bd4921d5-xxxx" },
      { role: "assistant", content: "已修復，commit e5f6g7h" },
    ];
    const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = buildCompactPrompt(conversationText, tokenBudget);

    // Task mode: engineering-focused
    expect(prompt).toContain("Summarise this engineering conversation");
    expect(prompt).toContain("a1b2c3d");
    expect(prompt).toContain("e5f6g7h");
    expect(prompt).toContain(`Token budget: ${tokenBudget} tokens max`);
  });

  it("compact prompt + token budget integration: general mode with compactModel", () => {
    const compactModel = "gpt-4.1-nano";
    const tokenBudget = getSummaryMaxTokens(compactModel);
    const messages = [
      { role: "user", content: "你好嗎" },
      { role: "assistant", content: "我很好，謝謝" },
    ];
    const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = buildCompactPrompt(conversationText, tokenBudget);

    // General mode: structured Chinese instruction
    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).toContain(`Token budget: ${tokenBudget} tokens max`);
  });

  it("incremental compact: existing summary + new task messages", () => {
    const tokenBudget = getSummaryMaxTokens("claude-haiku-4-5");
    const existing = "Prior: deployed v2.0, card bd4921d5 marked done";
    const newText = "user: new bug in commit ff00112\nassistant: fixing...";
    const prompt = buildCompactPrompt(newText, tokenBudget, existing);

    // Task mode (has commit hash), incremental (has existing summary)
    expect(prompt).toContain("Previous summary:");
    expect(prompt).toContain(existing);
    expect(prompt).toContain("New messages:");
    expect(prompt).toContain("ff00112");
  });

  // ── Token budget is always included ──

  it("includes token budget in both modes", () => {
    const taskText = "user: fix the bug in commit abc1234";
    const generalText = "user: 你好";
    expect(buildCompactPrompt(taskText, 1500)).toContain("Token budget: 1500 tokens max");
    expect(buildCompactPrompt(generalText, 999)).toContain("Token budget: 999 tokens max");
  });

  // ── Task mode preserves key engineering artifacts ──

  it("task mode prompt instructs to preserve key artifacts", () => {
    const text = "user: PR #42 merged commit abc1234";
    const prompt = buildCompactPrompt(text, 1000);
    expect(prompt).toContain("PR numbers");
    expect(prompt).toContain("file paths");
    expect(prompt).toContain("## Active Task");
    expect(prompt).toContain("## Key Decisions");
    expect(prompt).toContain("## Modified Files");
    expect(prompt).toContain("## Pending");
  });

  // ── Structured format: multi-round compact (compact of compact) ──

  it("task mode: existing structured summary is preserved as 'Previous summary' for re-compaction", () => {
    const existingSummary = [
      "## Active Task",
      "- Implement A2A memory injection — in-progress",
      "",
      "## Key Decisions",
      "- Use per-session env instead of shared provider env",
      "",
      "## Modified Files",
      "- src/index.ts — removed shared setEnv",
      "- src/providers/process.ts — per-session agentName",
    ].join("\n");
    const newText = "user: fix commit abc1234 — Bella found test gap\nassistant: added tests";
    const prompt = buildCompactPrompt(newText, 2000, existingSummary);

    // Task mode (commit hash in new text)
    expect(prompt).toContain("Summarise this engineering conversation");
    expect(prompt).toContain("## Active Task");
    // Previous structured summary passed through for LLM to merge
    expect(prompt).toContain("Previous summary:");
    expect(prompt).toContain("per-session env instead of shared provider env");
    expect(prompt).toContain("New messages:");
    expect(prompt).toContain("abc1234");
  });

  it("general mode: existing structured summary is preserved for re-compaction", () => {
    const existingSummary = [
      "## 重點摘要",
      "- 討論了週末旅行計畫",
      "",
      "## 決策紀錄",
      "- 選擇去花蓮",
    ].join("\n");
    const newText = "user: 住宿訂好了嗎\nassistant: 還沒";
    const prompt = buildCompactPrompt(newText, 1000, existingSummary);

    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).toContain("先前摘要:");
    expect(prompt).toContain("去花蓮");
    expect(prompt).toContain("後續對話:");
  });

  it("task detection considers existing summary too (catches structured summaries with card IDs)", () => {
    // New messages are plain, but existing summary has a card ID
    const existingSummary = "## Active Task\n- Card bd4921d5 — deploy feature";
    const newText = "user: 進度如何\nassistant: 快好了";
    const prompt = buildCompactPrompt(newText, 1000, existingSummary);

    // Should detect task mode from existing summary containing UUID
    expect(prompt).toContain("Summarise this engineering conversation");
  });

  // ── Negative: general summary with dates/numbers stays general ──

  it("general summary with date-like numbers (20260412) does NOT trigger task mode", () => {
    const existingSummary = "## 重點摘要\n- 2026年4月12日討論了旅行，預算 20260412 元";
    const newText = "user: 明天出發嗎\nassistant: 對";
    const prompt = buildCompactPrompt(newText, 1000, existingSummary);

    // Pure digits should NOT be treated as commit hashes
    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("general summary with numeric codes (1234567, 9876543) does NOT trigger task mode", () => {
    const existingSummary = "## 重點摘要\n- 訂單編號 1234567，追蹤碼 9876543";
    const newText = "user: 訂單到了嗎\nassistant: 還在配送中";
    const prompt = buildCompactPrompt(newText, 1000, existingSummary);

    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("real commit hash (with hex letters) still triggers task mode", () => {
    // a1b2c3d contains letters — should still detect
    const text = "user: 看一下 a1b2c3d 這個 commit";
    const prompt = buildCompactPrompt(text, 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
  });
});
