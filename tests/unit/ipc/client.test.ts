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
    vi.resetModules();
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

  it("rejects requests when the socket does not exist", async () => {
    existsSync.mockReturnValue(false);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    await expect(sendIpcRequest({ id: 1, method: "ping" })).rejects.toThrow("Bridge is not running (no socket found)");
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("throws for streamWatch when the socket does not exist", async () => {
    existsSync.mockReturnValue(false);
    const { streamWatch } = await import("../../../src/ipc/client.js");

    expect(() => streamWatch(vi.fn())).toThrow("Bridge is not running (no socket found)");
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("writes a newline-delimited JSON request on connect", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 7, method: "ping", params: { target: "lucy" } });
    conn.emit("connect");

    expect(conn.write).toHaveBeenCalledWith(
      JSON.stringify({ id: 7, method: "ping", params: { target: "lucy" } }) + "\n",
    );

    conn.emit("data", Buffer.from(JSON.stringify({ id: 7, result: { ok: true } }) + "\n"));
    await expect(request).resolves.toEqual({ id: 7, result: { ok: true } });
  });

  it("resolves with the first newline-delimited JSON response", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 2, method: "list-agents" });
    conn.emit("data", Buffer.from('{"id":2,'));
    conn.emit("data", Buffer.from('"result":[{"name":"lucy"}]}\n{"id":999,"result":false}\n'));

    await expect(request).resolves.toEqual({ id: 2, result: [{ name: "lucy" }] });
    expect(conn.destroy).toHaveBeenCalled();
  });

  it("rejects invalid JSON responses", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 3, method: "ping" });
    conn.emit("data", Buffer.from("not json\n"));

    await expect(request).rejects.toThrow("Invalid JSON response from bridge");
    expect(conn.destroy).toHaveBeenCalled();
  });

  it("rejects connection errors without hanging", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 4, method: "ping" });
    conn.emit("error", new Error("ECONNREFUSED"));

    await expect(request).rejects.toThrow("IPC connection failed: ECONNREFUSED");
  });

  it("rejects when the connection closes before a response", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 5, method: "ping" });
    conn.emit("close");

    await expect(request).rejects.toThrow("Connection closed before response");
  });

  it("does not reject after a settled response when close fires", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { sendIpcRequest } = await import("../../../src/ipc/client.js");

    const request = sendIpcRequest({ id: 6, method: "ping" });
    conn.emit("data", Buffer.from('{"id":6,"result":"pong"}\n'));
    conn.emit("close");

    await expect(request).resolves.toEqual({ id: 6, result: "pong" });
  });

  it("streamWatch writes the watch request and emits chunked non-empty lines", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { streamWatch } = await import("../../../src/ipc/client.js");
    const onEvent = vi.fn();

    const cleanup = streamWatch(onEvent, { onError: vi.fn(), onClose: vi.fn() });
    conn.emit("connect");
    conn.emit("data", Buffer.from('{"agent":"lucy"'));
    conn.emit("data", Buffer.from('}\n\n{"agent":"pan"}\npartial'));
    conn.emit("data", Buffer.from("-tail\n"));

    expect(conn.write).toHaveBeenCalledWith(JSON.stringify({ id: 0, method: "watch" }) + "\n");
    expect(onEvent).toHaveBeenNthCalledWith(1, '{"agent":"lucy"}');
    expect(onEvent).toHaveBeenNthCalledWith(2, '{"agent":"pan"}');
    expect(onEvent).toHaveBeenNthCalledWith(3, "partial-tail");

    cleanup();
    expect(conn.destroy).toHaveBeenCalled();
  });

  it("streamWatch calls injected lifecycle callbacks for error and close", async () => {
    const conn = new FakeConnection();
    createConnection.mockReturnValue(conn);
    const { streamWatch } = await import("../../../src/ipc/client.js");
    const onError = vi.fn();
    const onClose = vi.fn();

    streamWatch(vi.fn(), { onError, onClose });
    const err = new Error("socket failed");
    conn.emit("error", err);
    conn.emit("close");

    expect(onError).toHaveBeenCalledWith(err);
    expect(onClose).toHaveBeenCalled();
  });
});
