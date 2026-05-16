import { describe, it, expect } from "vitest";
import { TerminalParser } from "../../../src/pty/terminal-parser.js";

// xterm.js treats `\n` as LF only (cursor down, column unchanged); use `\r\n`
// so each rendered line starts at column 0 — that's how a real PTY emits text.
const NL = "\r\n";

function feed(parser: TerminalParser, lines: string[]): Promise<void> {
  // xterm.write is async; the buffer isn't populated until the write
  // callback fires.
  return parser.writeAsync(lines.join(NL));
}

function makeParser(): TerminalParser {
  return new TerminalParser(200, 50, 10000);
}

// Idle prompt box rendered by Claude CLI between turns. The parser
// recognises this shape via `findAllPromptBoxes`: a pure box-drawing
// top border, then a line whose trim() starts with `❯`, then a pure
// box-drawing bottom border.
const IDLE_BOX = [
  "╭" + "─".repeat(40) + "╮",
  "❯ ",
  "╰" + "─".repeat(40) + "╯",
];

describe("TerminalParser response boundary", async () => {
  it("excludes injected context lines that follow the ❯ prompt line", async () => {
    const parser = makeParser();
    const userMessage = "what's the status?";
    const sentPrompt = [
      "[Group conversation — other agents: Vivi]",
      "[Message from user: Ripple]",
      "[Recent history]",
      "Vivi: hello",
      "user: hi",
      "[/Recent history]",
      "",
      userMessage,
    ].join("\n");

    parser.setLastSentPrompt(sentPrompt);

    await feed(parser, [
      "❯ [Group conversation — other agents: Vivi]",
      "[Message from user: Ripple]",
      "[Recent history]",
      "Vivi: hello",
      "user: hi",
      "[/Recent history]",
      "",
      userMessage,
      "",
      "⏺ The status is green.",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("The status is green.");
    expect(text).not.toContain("[Recent history]");
    expect(text).not.toContain("Vivi: hello");
    expect(text).not.toContain(userMessage);
  });

  it("falls back to ❯ boundary when last-sent prompt is empty", async () => {
    const parser = makeParser();
    // No setLastSentPrompt — fallback path.

    await feed(parser, [
      "❯ hi",
      "",
      "⏺ Hello there.",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("Hello there.");
  });

  it("falls back to ❯ boundary when the tail line cannot be located in the buffer", async () => {
    const parser = makeParser();
    parser.setLastSentPrompt("totally-different-tail-that-never-appears");

    await feed(parser, [
      "❯ hi",
      "",
      "⏺ Hello there.",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    // stripInjectedContext leaves clean text alone; ❯-fallback still works.
    expect(text).toBe("Hello there.");
  });

  it("uses tail boundary even when injected context contains [/Recent history] marker", async () => {
    // Demonstrates the advantage of tail-boundary over regex strip: the
    // boundary lives in the structural buffer scan, not the text. Even if
    // the assistant's reply happens to contain the literal string
    // "[Recent history]" (would be regex-stripped), the tail boundary
    // unambiguously starts the response after the user's message line.
    const parser = makeParser();
    const userMessage = "ping";
    parser.setLastSentPrompt(`[Recent history]\nVivi: a\n[/Recent history]\n\n${userMessage}`);

    await feed(parser, [
      "❯ [Recent history]",
      "Vivi: a",
      "[/Recent history]",
      "",
      userMessage,
      "",
      "⏺ pong",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("pong");
  });

  it("filters HUD-sentinel status line and parses usage fields", async () => {
    // Bridge's statusline.sh prepends `__BRIDGE_HUD__` so the parser can
    // identify the row unambiguously. Claude CLI's own native widgets
    // (model indicator / effort hint) render on the same row to the
    // right — the whole row is dropped because it contains the sentinel.
    const parser = makeParser();
    const userMessage = "測試";
    parser.setLastSentPrompt(userMessage);

    await feed(parser, [
      "❯ " + userMessage,
      "",
      "__BRIDGE_HUD__ [Opus 4.7] ctx:42% | 5h:17% (59m) | 7d:4% (4d 23h 59m) | $0.066 ◉ xhigh · /effort paste again to expand",
      "⏺ Hi Ripple!",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("Hi Ripple!");
    expect(text).not.toContain("__BRIDGE_HUD__");
    expect(text).not.toContain("ctx:");
    expect(text).not.toContain("/effort");

    const usage = parser.getTurnUsage();
    expect(usage?.model).toBe("Opus 4.7");
    expect(usage?.contextPercent).toBe(42);
    expect(usage?.limit5hPercent).toBe(17);
    expect(usage?.limit5hResetIn).toBe("59m");
    expect(usage?.limit7dPercent).toBe(4);
    expect(usage?.limit7dResetIn).toBe("4d 23h 59m");
    expect(usage?.costUsd).toBeCloseTo(0.066, 3);
  });

  it("skips arbitrary CLI chrome between user tail and the ⏺ response marker", async () => {
    // The `⏺` glyph is Claude CLI's stable allowlist anchor for assistant
    // output. Any chrome that renders between the user's message and the
    // first ⏺ — native model widget, /effort hint, paste-again-to-expand
    // overlay, status line, future widgets — must be skipped without
    // per-pattern enumeration.
    const parser = makeParser();
    const userMessage = "ping";
    parser.setLastSentPrompt(userMessage);

    await feed(parser, [
      "❯ " + userMessage,
      "",
      "paste again to expand",
      "◉ xhigh",
      "__BRIDGE_HUD__ [Opus 4.7] ctx:1% | 5h:0% | 7d:0% | $0.001",
      "⏺ pong",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("pong");
    expect(text).not.toContain("paste again to expand");
    expect(text).not.toContain("◉");
    expect(text).not.toContain("__BRIDGE_HUD__");
  });

  it("extractStreamingDelta bounds end at idle prompt box, excluding hint overlay below it", async () => {
    // Mid-stream buffer has the idle prompt box and status/hint zone
    // permanently rendered at the bottom. Without an end boundary, lines
    // below the idle box (`paste again to expand`, native widgets) leak
    // into the captured content and corrupt the startsWith() incremental
    // check on subsequent polls.
    const parser = makeParser();
    const userMessage = "測試";
    parser.setLastSentPrompt(userMessage);

    await feed(parser, [
      "❯ " + userMessage,
      "",
      "⏺ Hi Ripple!",
      "",
      "  看到你發了幾次「測試」",
      "",
      ...IDLE_BOX,
      "__BRIDGE_HUD__ [Opus 4.7] ctx:2% | 5h:20% | 7d:3% | $0.060",
      "  paste again to expand",
      "",
    ]);

    const delta = parser.extractStreamingDelta();
    expect(delta).not.toBeNull();
    expect(delta).not.toContain("paste again to expand");
    expect(delta).not.toContain("__BRIDGE_HUD__");
    expect(delta).toContain("Hi Ripple!");
    expect(delta).toContain("看到你發了幾次");
  });

  it("extractStreamingDelta survives mid-stream reflow without re-emitting from scratch", async () => {
    // Claude CLI sometimes collapses a `\n\n` between paragraphs into a
    // single `\n` once more text has rendered. Strict startsWith would
    // then report false and the old code fell back to emitting the entire
    // currentContent as a delta — making the chat UI display a duplicate
    // message bubble. The LCP-based fallback emits only the divergent
    // tail instead.
    const parser = makeParser();
    const userMessage = "測試";
    parser.setLastSentPrompt(userMessage);

    // First state: paragraph break is `\n\n`.
    await feed(parser, [
      "❯ " + userMessage,
      "",
      "⏺ 收到。",
      "",
      "  我猜這可能是：",
      "",
      "  1. 訊息測試",
      ...IDLE_BOX,
      "",
    ]);
    const delta1 = parser.extractStreamingDelta();
    expect(delta1).toContain("1. 訊息測試");

    // Second state: CLI reflowed — the blank line between paragraph head
    // and the numbered list is gone, AND new content has been appended.
    // Wipe + rewrite the buffer to simulate the redraw.
    await feed(parser, [
      "\x1b[2J\x1b[H", // clear screen + home
      "❯ " + userMessage,
      "",
      "⏺ 收到。",
      "",
      "  我猜這可能是：",
      "  1. 訊息測試",
      "  2. 想叫我開始 QA",
      ...IDLE_BOX,
      "",
    ]);
    const delta2 = parser.extractStreamingDelta();
    expect(delta2).not.toBeNull();
    // Must NOT be the entire response from scratch — that's the bug we're fixing.
    expect(delta2!.startsWith("收到。")).toBe(false);
    // Must contain the newly-arrived line.
    expect(delta2).toContain("2. 想叫我開始 QA");
  });

  it("returns empty when there is no ⏺ marker yet (response not started)", async () => {
    const parser = makeParser();
    const userMessage = "ping";
    parser.setLastSentPrompt(userMessage);

    await feed(parser, [
      "❯ " + userMessage,
      "",
      "paste again to expand",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("");
  });

  describe("tool block filtering", () => {
    it("drops `⏺ Bash(...)` invocation + ⎿ result + indented continuation", async () => {
      const parser = makeParser();
      const userMessage = "ls 一下";
      parser.setLastSentPrompt(userMessage);

      await feed(parser, [
        "❯ " + userMessage,
        "",
        "⏺ I'll check.",
        "",
        "⏺ Bash(cd ~/proj && ls -la)",
        "  ⎿  total 6784",
        "     drwxr-xr-x@ 16 ripple  staff      512 11 May 23:59 .",
        "     drwxr-xr-x@  3 ripple  staff       96  5 Apr 22:11 ..",
        "     … +14 lines (ctrl+o to expand)",
        "  ⎿  Shell cwd was reset to ~/.arinova-bridge/workspace-ron",
        "",
        "⏺ Found 14 files.",
        "",
        ...IDLE_BOX,
        "",
      ]);

      const { text } = parser.extractResponseContent();
      expect(text).toContain("I'll check.");
      expect(text).toContain("Found 14 files.");
      expect(text).not.toContain("Bash(");
      expect(text).not.toContain("⎿");
      expect(text).not.toContain("total 6784");
      expect(text).not.toContain("drwxr-xr-x");
      expect(text).not.toContain("Shell cwd was reset");
    });

    it("drops MCP `⏺ Calling X… (ctrl+o to expand)` and `⏺ Called X (ctrl+o to expand)`", async () => {
      const parser = makeParser();
      const userMessage = "查 status";
      parser.setLastSentPrompt(userMessage);

      await feed(parser, [
        "❯ " + userMessage,
        "",
        "⏺ Let me check.",
        "",
        "⏺ Calling arinova… (ctrl+o to expand)",
        "  ⎿  \"agent.get_status\"",
        "",
        "⏺ Called arinova (ctrl+o to expand)",
        "  ⎿  \"alive\": true",
        "",
        "⏺ Status: alive.",
        "",
        ...IDLE_BOX,
        "",
      ]);

      const { text } = parser.extractResponseContent();
      expect(text).toContain("Let me check.");
      expect(text).toContain("Status: alive.");
      expect(text).not.toContain("Calling arinova");
      expect(text).not.toContain("Called arinova");
      expect(text).not.toContain("agent.get_status");
      expect(text).not.toContain("alive\": true");
    });

    it("returns empty when the entire turn is tool-only (no plain ⏺ text)", async () => {
      const parser = makeParser();
      const userMessage = "刪掉";
      parser.setLastSentPrompt(userMessage);

      await feed(parser, [
        "❯ " + userMessage,
        "",
        "⏺ Bash(rm -rf /tmp/junk)",
        "  ⎿  ",
        "",
        ...IDLE_BOX,
        "",
      ]);

      const { text } = parser.extractResponseContent();
      expect(text).toBe("");
    });

    it("does not falsely treat assistant prose mentioning a tool name as a tool invocation", async () => {
      // The TOOL_INVOCATION regex requires `⏺ <ToolName>(` with the opening
      // paren, so assistant text like "I'll use Bash to..." is preserved.
      const parser = makeParser();
      const userMessage = "建議方法";
      parser.setLastSentPrompt(userMessage);

      await feed(parser, [
        "❯ " + userMessage,
        "",
        "⏺ I'll use Bash to run the script.",
        "",
        ...IDLE_BOX,
        "",
      ]);

      const { text } = parser.extractResponseContent();
      expect(text).toBe("I'll use Bash to run the script.");
    });

    it("extractStreamingDelta also filters tool blocks during streaming", async () => {
      const parser = makeParser();
      const userMessage = "ls";
      parser.setLastSentPrompt(userMessage);

      await feed(parser, [
        "❯ " + userMessage,
        "",
        "⏺ Checking.",
        "",
        "⏺ Bash(ls)",
        "  ⎿  Running…",
        "",
        ...IDLE_BOX,
        "",
      ]);

      const delta = parser.extractStreamingDelta();
      expect(delta).toContain("Checking.");
      expect(delta).not.toContain("Bash(");
      expect(delta).not.toContain("Running…");
    });
  });

  it("still parses legacy `[model] ctx:` status line (no sentinel)", async () => {
    // Back-compat for users whose statusline.sh predates the sentinel
    // and only emits `[model] ctx:N% | 5h:N% | 7d:N%`. The narrow
    // bracketed shape must still be recognised + parsed.
    const parser = makeParser();
    const userMessage = "hi";
    parser.setLastSentPrompt(userMessage);

    await feed(parser, [
      "❯ " + userMessage,
      "",
      "[Sonnet 4.6] ctx:5% | 5h:10% (30m) | 7d:2% (3d)",
      "⏺ Hey.",
      "",
      ...IDLE_BOX,
      "",
    ]);

    const { text } = parser.extractResponseContent();
    expect(text).toBe("Hey.");

    const usage = parser.getTurnUsage();
    expect(usage?.model).toBe("Sonnet 4.6");
    expect(usage?.contextPercent).toBe(5);
    expect(usage?.limit5hPercent).toBe(10);
    expect(usage?.limit7dPercent).toBe(2);
  });
});
