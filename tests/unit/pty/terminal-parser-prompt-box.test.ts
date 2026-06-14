import { describe, it, expect } from "vitest";
import { TerminalParser } from "../../../src/pty/terminal-parser.js";

const TOP = "╭──────────────────────╮";
const BOTTOM = "╰──────────────────────╯";

function makeParser(): TerminalParser {
  return new TerminalParser(80, 24, 1000);
}

async function writeScreen(parser: TerminalParser, lines: string[]): Promise<void> {
  await parser.writeAsync(lines.join("\r\n") + "\r\n");
}

describe("TerminalParser.getPromptBoxInput", () => {
  it("returns null when no prompt box is on screen", async () => {
    const parser = makeParser();
    await writeScreen(parser, ["Welcome to Claude", "some output"]);
    expect(parser.getPromptBoxInput()).toBeNull();
  });

  it("returns empty string for an empty input box", async () => {
    const parser = makeParser();
    await writeScreen(parser, ["⏺ previous response", TOP, "❯ ", BOTTOM]);
    expect(parser.getPromptBoxInput()).toBe("");
  });

  it("returns typed text from the input box", async () => {
    const parser = makeParser();
    await writeScreen(parser, [TOP, "❯ hello world", BOTTOM]);
    expect(parser.getPromptBoxInput()).toBe("hello world");
  });

  it("joins multi-line input inside the box", async () => {
    const parser = makeParser();
    await writeScreen(parser, [TOP, "❯ first line", "second line", BOTTOM]);
    expect(parser.getPromptBoxInput()).toBe("first line\nsecond line");
  });

  it("returns the paste placeholder for collapsed pastes", async () => {
    const parser = makeParser();
    await writeScreen(parser, [TOP, "❯ [Pasted text #1 +42 lines]", BOTTOM]);
    expect(parser.getPromptBoxInput()).toBe("[Pasted text #1 +42 lines]");
  });

  it("ignores bordered widgets without a prompt marker", async () => {
    const parser = makeParser();
    await writeScreen(parser, [TOP, "Some dialog content", BOTTOM]);
    expect(parser.getPromptBoxInput()).toBeNull();
  });

  it("reads the box even with a status line rendered below it", async () => {
    const parser = makeParser();
    await writeScreen(parser, [TOP, "❯ draft text", BOTTOM, "model: opus | 42% ctx"]);
    expect(parser.getPromptBoxInput()).toBe("draft text");
  });
});

describe("TerminalParser.extractStreamingDelta tool filtering", () => {
  // Regression: while a tool is still running the CLI paints the bullet as an
  // in-progress spinner frame (here ✦, outside the known spinner set) instead
  // of the settled ⏺, so the strict `^⏺ Bash(` filter missed it and the live
  // stream leaked the `Bash(…)` line. It vanished at stream-end only because
  // the final response is rebuilt from the transcript.
  it("drops an in-progress tool line with a non-standard spinner bullet", async () => {
    const parser = makeParser();
    await writeScreen(parser, [
      "❯ run ls",
      "⏺ Let me list the files.",
      "✦ Bash(ls -la)",
      "  ⎿  Running…",
    ]);
    const delta = parser.extractStreamingDelta();
    expect(delta).toContain("Let me list the files.");
    expect(delta).not.toContain("Bash(");
  });

  it("drops the settled ⏺ tool frame and keeps the surrounding text", async () => {
    const parser = makeParser();
    await writeScreen(parser, [
      "❯ run ls",
      "⏺ Listing files now.",
      "⏺ Bash(ls -la)",
      "  ⎿  total 0",
      "⏺ Done.",
    ]);
    const delta = parser.extractStreamingDelta();
    expect(delta).toContain("Listing files now.");
    expect(delta).toContain("Done.");
    expect(delta).not.toContain("Bash(");
    expect(delta).not.toContain("total 0");
  });

  it("drops the CLI session-feedback prompt from the stream", async () => {
    const parser = makeParser();
    await writeScreen(parser, [
      "❯ hi",
      "⏺ Here is the answer.",
      "● How is Claude doing this session? (optional)",
      "1: Bad  2: Fine  3: Good  0: Dismiss",
    ]);
    const delta = parser.extractStreamingDelta();
    expect(delta).toContain("Here is the answer.");
    expect(delta).not.toContain("How is Claude doing");
    expect(delta).not.toContain("Dismiss");
  });

  it("keeps prose/code that merely looks like a tool call (no bullet glyph)", async () => {
    const parser = makeParser();
    await writeScreen(parser, [
      "❯ explain",
      "⏺ Use this pattern:",
      "  Read(buffer) returns bytes",
      "  - Grep(pattern) is also fine",
    ]);
    const delta = parser.extractStreamingDelta();
    expect(delta).toContain("Read(buffer) returns bytes");
    expect(delta).toContain("- Grep(pattern) is also fine");
  });
});
