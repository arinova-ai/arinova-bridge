import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.hoisted(() => vi.fn(() => true));
const createConnection = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: { existsSync },
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/test",
}));

vi.mock("node:net", () => ({
  default: { createConnection },
}));

class FakeConnection extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn();
}

describe("ipc/client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    existsSync.mockReturnValue(true);
    createConnection.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the configured request timeout in seconds", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 1, method: "ping" });
    const assertion = expect(request).rejects.toThrow("IPC request timed out (600s)");
    await vi.advanceTimersByTimeAsync(600_000);

    await assertion;
    expect(conn.destroy).toHaveBeenCalled();
  });
});
