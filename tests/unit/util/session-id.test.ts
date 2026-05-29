import { describe, it, expect } from "vitest";
import { A2A_PREFIX, isAgentSession, parseA2aDepth } from "../../../src/util/session-id.js";

describe("A2A_PREFIX", () => {
  it("equals 'a2a:'", () => {
    expect(A2A_PREFIX).toBe("a2a:");
  });
});

describe("isAgentSession", () => {
  it("returns true when conversationId starts with agentName:", () => {
    expect(isAgentSession("alice:default", "alice")).toBe(true);
  });

  it("returns true for any suffix after the colon", () => {
    expect(isAgentSession("alice:some-other-session", "alice")).toBe(true);
  });

  it("returns false when conversationId belongs to a different agent", () => {
    expect(isAgentSession("bob:default", "alice")).toBe(false);
  });

  it("returns false when agentName is a prefix of the actual agent name", () => {
    // "ali" is a prefix of "alice", but "ali:" is not the start of "alice:default"
    expect(isAgentSession("alice:default", "ali")).toBe(false);
  });

  it("returns false for an empty conversationId", () => {
    expect(isAgentSession("", "alice")).toBe(false);
  });

  it("returns false for an empty agentName", () => {
    // Empty agent name means prefix is ":", which doesn't match "alice:default"
    expect(isAgentSession("alice:default", "")).toBe(false);
  });

  it("returns true when agentName is empty and conversationId starts with ':'", () => {
    expect(isAgentSession(":default", "")).toBe(true);
  });

  it("handles agent names with special characters", () => {
    expect(isAgentSession("my-agent:default", "my-agent")).toBe(true);
    expect(isAgentSession("my_agent:default", "my_agent")).toBe(true);
  });
});

describe("parseA2aDepth", () => {
  it("returns 0 for a non-A2A conversationId", () => {
    expect(parseA2aDepth("alice:default")).toBe(0);
  });

  it("returns the depth for a valid A2A conversationId", () => {
    expect(parseA2aDepth("a2a:1:rest")).toBe(1);
  });

  it("returns 0 when depth segment is not a number", () => {
    expect(parseA2aDepth("a2a:abc:rest")).toBe(0);
  });

  it("returns 0 for a2a: prefix with no depth segment", () => {
    expect(parseA2aDepth("a2a:")).toBe(0);
  });

  it("parses larger depth values", () => {
    expect(parseA2aDepth("a2a:5:some:nested:id")).toBe(5);
  });

  it("returns 0 for an empty string", () => {
    expect(parseA2aDepth("")).toBe(0);
  });

  it("returns 0 for strings that partially match the prefix", () => {
    expect(parseA2aDepth("a2a")).toBe(0);
    expect(parseA2aDepth("a2")).toBe(0);
  });
});
