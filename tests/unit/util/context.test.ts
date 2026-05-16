import { describe, it, expect } from "vitest";
import { stripInjectedContext, hasUnclosedInjectionBlock } from "../../../src/util/context.js";

describe("stripInjectedContext", () => {
  it("returns empty/falsy input unchanged", () => {
    expect(stripInjectedContext("")).toBe("");
  });

  it("strips a [Recent history] block followed by the assistant reply", () => {
    const polluted = [
      "[Recent history]",
      "user: action call可以看到agent有沒有在working嗎",
      "Linda: 可以，有 arinova.agent.get_status 可以查 agent 狀態。",
      "user: hi",
      "[/Recent history]",
      "",
      "Hi! 有什麼需要幫忙的嗎？",
    ].join("\n");

    expect(stripInjectedContext(polluted)).toBe("Hi! 有什麼需要幫忙的嗎？");
  });

  it("strips [Conversation summary] block", () => {
    const polluted = "[Conversation summary]\nUser worked on X.\n[/Conversation summary]\n\nOK, continuing.";
    expect(stripInjectedContext(polluted)).toBe("OK, continuing.");
  });

  it("strips [Fork context from main session] ... [Fork task] wrapper", () => {
    const polluted = "[Fork context from main session]\nuser: hi\nbot: hey\n\n[Fork task]\nactual reply here";
    expect(stripInjectedContext(polluted)).toBe("actual reply here");
  });

  it("strips single-line bracket tags", () => {
    expect(stripInjectedContext("[Group conversation — other agents: Alice, Bob]\nactual reply")).toBe("actual reply");
    expect(stripInjectedContext("[Message from user: alice]\nactual reply")).toBe("actual reply");
    expect(stripInjectedContext("[Replying to bot: hi there]\nactual reply")).toBe("actual reply");
  });

  it("strips [Sender memories] block until blank line", () => {
    const polluted = "[Sender memories — from alice]\n- memory one\n- memory two\n\nthe reply";
    expect(stripInjectedContext(polluted)).toBe("the reply");
  });

  it("strips <user-current-message> wrapper", () => {
    const polluted = "<user-current-message>\nhi\n</user-current-message>\n\nreply";
    expect(stripInjectedContext(polluted)).toBe("reply");
  });

  it("leaves clean responses unchanged", () => {
    expect(stripInjectedContext("Just a normal reply.")).toBe("Just a normal reply.");
  });

  it("detects an unclosed [Recent history] block", () => {
    const partial = "[Recent history]\nuser: 1\nVivi: 2";
    expect(hasUnclosedInjectionBlock(partial)).toBe(true);
  });

  it("treats a closed [Recent history] block as not unclosed", () => {
    const closed = "[Recent history]\nuser: 1\n[/Recent history]\nHi";
    expect(hasUnclosedInjectionBlock(closed)).toBe(false);
  });

  it("treats clean response text as not unclosed", () => {
    expect(hasUnclosedInjectionBlock("Hi! 有什麼需要幫忙的嗎？")).toBe(false);
    expect(hasUnclosedInjectionBlock("")).toBe(false);
  });

  it("handles multiple injected blocks stacked together", () => {
    const polluted = [
      "[Message from user: alice]",
      "[Recent history]",
      "user: prior",
      "bot: prior response",
      "[/Recent history]",
      "",
      "the real reply",
    ].join("\n");
    expect(stripInjectedContext(polluted)).toBe("the real reply");
  });
});
