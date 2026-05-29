import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildCompactPrompt, getSummaryMaxTokens } from "../../../src/session/bridge-session.js";
import { BridgeSessionStore } from "../../../src/session/bridge-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Compact v3 — Structured summary: integration + edge case tests
// ---------------------------------------------------------------------------

function createLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    error: (msg: string) => logs.push({ level: "error", msg }),
    debug: (msg: string) => logs.push({ level: "debug", msg }),
    _logs: logs,
  };
}

// ---------------------------------------------------------------------------
// 1. isTaskOriented() — regex edge cases (tested via buildCompactPrompt)
// ---------------------------------------------------------------------------

describe("isTaskOriented — commit hash regex edge cases", () => {
  it("7-char hex with letters triggers task mode", () => {
    const prompt = buildCompactPrompt("看一下 deadbee 這個改動", 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
  });

  it("40-char full SHA triggers task mode", () => {
    const sha = "a".repeat(7) + "0".repeat(33); // 40 chars with letters
    const prompt = buildCompactPrompt(`commit ${sha}`, 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
  });

  it("6-char hex (too short) does NOT trigger", () => {
    // "abcdef" is only 6 chars — below threshold
    const prompt = buildCompactPrompt("code abcdef 結束", 1000);
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("41-char hex (too long) does NOT trigger as commit hash", () => {
    // 41 consecutive hex chars between word boundaries exceeds {7,40} — no match
    // because \b only fires at the edges of the whole run, and 41 > 40
    const long = "a" + "0".repeat(40); // 41 chars, all hex
    const prompt = buildCompactPrompt(`hash ${long} end`, 1000);
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("pure digits 0000000 (7 chars) does NOT trigger — no letters", () => {
    const prompt = buildCompactPrompt("id 0000000 done", 1000);
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("phone number 0912345678 does NOT trigger — pure digits", () => {
    const prompt = buildCompactPrompt("電話 0912345678", 1000);
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("mixed: date + real commit in same text triggers task mode", () => {
    const prompt = buildCompactPrompt("20260412 更新，commit abc1234", 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
  });

  it("UUID-style card ID (8 hex digits + dash) triggers task mode", () => {
    const prompt = buildCompactPrompt("卡片 bd4921d5-9511", 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
  });

  it("case insensitive keyword 'FIX' triggers task mode", () => {
    const prompt = buildCompactPrompt("FIX the production issue", 1000);
    expect(prompt).toContain("Summarise this engineering conversation");
  });
});

// ---------------------------------------------------------------------------
// 2. Structured format output validation
// ---------------------------------------------------------------------------

describe("Structured format — task mode sections", () => {
  it("task mode prompt has all 5 sections in correct order", () => {
    const prompt = buildCompactPrompt("commit abc1234 done", 1000);
    const activeIdx = prompt.indexOf("## Active Task");
    const decisionsIdx = prompt.indexOf("## Key Decisions");
    const filesIdx = prompt.indexOf("## Modified Files");
    const pendingIdx = prompt.indexOf("## Pending");
    const contextIdx = prompt.indexOf("## Context");

    expect(activeIdx).toBeGreaterThan(-1);
    expect(decisionsIdx).toBeGreaterThan(activeIdx);
    expect(filesIdx).toBeGreaterThan(decisionsIdx);
    expect(pendingIdx).toBeGreaterThan(filesIdx);
    expect(contextIdx).toBeGreaterThan(pendingIdx);
  });

  it("task mode instructs to omit empty sections", () => {
    const prompt = buildCompactPrompt("fix bug abc1234", 1000);
    expect(prompt).toContain("Omit a section if nothing applies");
    expect(prompt).toContain("do NOT leave it empty");
  });

  it("task mode instructs to preserve engineering artifacts", () => {
    const prompt = buildCompactPrompt("deploy PR #42", 1000);
    expect(prompt).toContain("commit hashes");
    expect(prompt).toContain("card/ticket IDs");
    expect(prompt).toContain("PR numbers");
    expect(prompt).toContain("file paths");
    expect(prompt).toContain("function names");
  });
});

describe("Structured format — general mode sections", () => {
  it("general mode has all 3 sections in correct order", () => {
    const prompt = buildCompactPrompt("你好，今天天氣不錯", 1000);
    const summaryIdx = prompt.indexOf("## 重點摘要");
    const decisionIdx = prompt.indexOf("## 決策紀錄");
    const todoIdx = prompt.indexOf("## 待辦事項");

    expect(summaryIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(summaryIdx);
    expect(todoIdx).toBeGreaterThan(decisionIdx);
  });

  it("general mode instructs to omit empty sections (Chinese)", () => {
    const prompt = buildCompactPrompt("隨便聊聊", 1000);
    expect(prompt).toContain("若該區段無內容則省略");
    expect(prompt).toContain("不要留空");
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-round compact mode stability
// ---------------------------------------------------------------------------

describe("Multi-round compact — mode stability", () => {
  it("task mode: structured summary with ## headings + commit hash stays in task mode", () => {
    const existingSummary = [
      "## Active Task",
      "- Implement compact v3 — in-progress, commit abc1234",
      "",
      "## Key Decisions",
      "- Use structured format for better info density",
      "",
      "## Modified Files",
      "- src/session/bridge-session.ts — added buildCompactPrompt",
    ].join("\n");
    // New messages are plain Chinese (no task markers)
    const newText = "user: 進度如何\nassistant: 快好了";
    const prompt = buildCompactPrompt(newText, 2000, existingSummary);

    // Should stay task mode because existing summary has commit hash
    expect(prompt).toContain("Summarise this engineering conversation");
    expect(prompt).toContain("Previous summary:");
    expect(prompt).toContain("New messages:");
  });

  it("general mode: Chinese structured summary without task markers stays general", () => {
    const existingSummary = [
      "## 重點摘要",
      "- 討論了下週的家庭旅行，目的地花蓮",
      "",
      "## 決策紀錄",
      "- 選擇火車而非飛機，因為票價便宜",
      "",
      "## 待辦事項",
      "- 訂住宿 — 小明",
    ].join("\n");
    const newText = "user: 車票買了嗎\nassistant: 還沒，明天買";
    const prompt = buildCompactPrompt(newText, 1000, existingSummary);

    // Should stay general mode — no commit hash, no UUID, no keywords
    expect(prompt).toContain("請將以下對話整理成以下結構化格式");
    expect(prompt).not.toContain("Summarise this engineering conversation");
  });

  it("3-round task mode: each round produces task-mode prompt with full history", () => {
    // Round 1
    const round1Text = "user: fix bug in commit abc1234\nassistant: fixed";
    const prompt1 = buildCompactPrompt(round1Text, 2000);
    expect(prompt1).toContain("Summarise this engineering conversation");

    // Round 2: summary from round 1 + new messages
    const round1Summary = "## Active Task\n- Fix bug abc1234 — done";
    const round2Text = "user: new feature commit def5678\nassistant: implementing";
    const prompt2 = buildCompactPrompt(round2Text, 2000, round1Summary);
    expect(prompt2).toContain("Summarise this engineering conversation");
    expect(prompt2).toContain("Previous summary:");
    expect(prompt2).toContain("abc1234"); // preserved from summary
    expect(prompt2).toContain("def5678"); // from new messages

    // Round 3: merged summary + plain follow-up
    const round2Summary = "## Active Task\n- Fix abc1234 done, implement def5678 — in-progress";
    const round3Text = "user: 進度報告\nassistant: 80% 完成";
    const prompt3 = buildCompactPrompt(round3Text, 2000, round2Summary);
    // Still task mode because summary has commit hashes
    expect(prompt3).toContain("Summarise this engineering conversation");
  });
});

// ---------------------------------------------------------------------------
// 4. Summary truncation (integration with BridgeSessionStore.compact)
// ---------------------------------------------------------------------------

describe("Summary truncation on compact", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  let logger: ReturnType<typeof createLogger>;
  const convId = "trunc-test";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-trunc-"));
    logger = createLogger();
    store = new BridgeSessionStore(tmpDir, logger as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("truncates summary exceeding token budget and appends [...truncated]", async () => {
    // Add enough messages to trigger compact
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg ${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg ${i}`, "bot");
      }
    }

    // Return a very long summary that exceeds 2000 tokens
    const longSummary = "word ".repeat(5000); // ~5000 tokens
    await store.compact(convId, async () => longSummary);

    // Verify truncation happened
    const ctx = store.buildContext(convId);
    expect(ctx).toContain("[...truncated]");

    // Verify logger warned
    const warnLogs = logger._logs.filter((l) => l.level === "warn");
    expect(warnLogs.some((l) => l.msg.includes("exceeded budget"))).toBe(true);
  });

  it("does NOT truncate summary within token budget", async () => {
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg ${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg ${i}`, "bot");
      }
    }

    const shortSummary = "## Active Task\n- Short task — done";
    await store.compact(convId, async () => shortSummary);

    const ctx = store.buildContext(convId);
    expect(ctx).toContain(shortSummary);
    expect(ctx).not.toContain("[...truncated]");
  });
});

// ---------------------------------------------------------------------------
// 5. Structured summary in buildContext — format preservation
// ---------------------------------------------------------------------------

describe("Structured summary in buildContext", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  const convId = "ctx-struct-test";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-struct-"));
    store = new BridgeSessionStore(tmpDir, createLogger() as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("structured task summary is wrapped in [Conversation summary] tags", async () => {
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg ${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg ${i}`, "bot");
      }
    }

    const structuredSummary = [
      "## Active Task",
      "- Implement feature X — done",
      "",
      "## Key Decisions",
      "- Use approach A over B",
    ].join("\n");

    await store.compact(convId, async () => structuredSummary);

    const ctx = store.buildContext(convId);
    expect(ctx).toContain("[Conversation summary]");
    expect(ctx).toContain("## Active Task");
    expect(ctx).toContain("- Implement feature X — done");
    expect(ctx).toContain("## Key Decisions");
    expect(ctx).toContain("[/Conversation summary]");

    // Summary before messages
    const summaryIdx = ctx.indexOf("[Conversation summary]");
    const msgIdx = ctx.indexOf("user: msg");
    expect(summaryIdx).toBeLessThan(msgIdx);
  });

  it("structured Chinese summary preserved in buildContext", async () => {
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `對話 ${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `回覆 ${i}`, "bot");
      }
    }

    const chineseSummary = ["## 重點摘要", "- 討論了系統架構", "", "## 決策紀錄", "- 選擇 PostgreSQL"].join("\n");

    await store.compact(convId, async () => chineseSummary);

    const ctx = store.buildContext(convId);
    expect(ctx).toContain("## 重點摘要");
    expect(ctx).toContain("選擇 PostgreSQL");
  });

  it("multi-round compact: summary accumulates correctly in buildContext", async () => {
    // First round
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) store.addUserMessage(convId, `r1-msg-${i}`, "user");
      else store.addAssistantMessage(convId, `r1-msg-${i}`, "bot");
    }

    await store.compact(convId, async (_msgs, existing) => {
      expect(existing).toBeUndefined(); // first compact
      return "## Active Task\n- Round 1 work — done";
    });

    // Add more messages for second round
    for (let i = 1; i <= 15; i++) {
      store.addUserMessage(convId, `r2-msg-${i}`, "user");
    }

    await store.compact(convId, async (_msgs, existing) => {
      // Should receive first summary
      expect(existing).toBe("## Active Task\n- Round 1 work — done");
      return "## Active Task\n- Round 1 done, Round 2 — in-progress";
    });

    const ctx = store.buildContext(convId);
    expect(ctx).toContain("Round 1 done, Round 2");
    expect(ctx).toContain("[Conversation summary]");
  });
});
