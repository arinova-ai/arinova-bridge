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
