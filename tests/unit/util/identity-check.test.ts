import { describe, it, expect, vi } from "vitest";
import { verifyAgentIdentity } from "../../../src/util/identity-check.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function mockAgent(result: { status: string; result?: Record<string, unknown> | null }) {
  return { callAction: vi.fn().mockResolvedValue(result) };
}

describe("verifyAgentIdentity", () => {
  it("resolves when server name matches expected agent name", async () => {
    const agent = mockAgent({ status: "success", result: { name: "Ron", agentId: "abc" } });
    await expect(verifyAgentIdentity(agent, "Ron", mockLogger as never)).resolves.toBeUndefined();
    expect(agent.callAction).toHaveBeenCalledWith("arinova.agent.get_status", {});
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("identity verified"));
  });

  it("throws on name mismatch", async () => {
    const agent = mockAgent({ status: "success", result: { name: "Derek", agentId: "xyz" } });
    await expect(verifyAgentIdentity(agent, "Ron", mockLogger as never)).rejects.toThrow(
      /identity mismatch.*"Derek".*"Ron"/,
    );
  });

  it("throws when get_status returns error status", async () => {
    const agent = mockAgent({ status: "error", result: null });
    await expect(verifyAgentIdentity(agent, "Ron", mockLogger as never)).rejects.toThrow(
      /get_status returned status="error"/,
    );
  });

  it("throws when get_status returns no result", async () => {
    const agent = mockAgent({ status: "success", result: null });
    await expect(verifyAgentIdentity(agent, "Ron", mockLogger as never)).rejects.toThrow(
      /get_status returned status="success"/,
    );
  });

  it("throws when result has no name field", async () => {
    const agent = mockAgent({ status: "success", result: { agentId: "abc" } });
    await expect(verifyAgentIdentity(agent, "Ron", mockLogger as never)).rejects.toThrow(
      /no agent name/,
    );
  });

  it("throws when callAction itself rejects", async () => {
    const agent = { callAction: vi.fn().mockRejectedValue(new Error("network timeout")) };
    await expect(verifyAgentIdentity(agent, "Ron", mockLogger as never)).rejects.toThrow(
      "network timeout",
    );
  });
});
