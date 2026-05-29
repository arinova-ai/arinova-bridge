import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { CodexRpcClient } from "../../../src/codex/rpc-client.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createClient(timeoutMs = 1000) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexRpcClient(stdin, stdout, mockLogger as never, timeoutMs);
  return { client, stdin, stdout };
}

describe("codex/rpc-client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("request", () => {
    it("sends request and resolves on response", async () => {
      const { client, stdin, stdout } = createClient();
      const written: string[] = [];
      stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

      const promise = client.request("test.method", { foo: "bar" });

      // Simulate response
      await new Promise((r) => setTimeout(r, 10));
      const sent = JSON.parse(written[0]);
      stdout.write(JSON.stringify({ id: sent.id, result: { ok: true } }) + "\n");

      const result = await promise;
      expect(result).toEqual({ ok: true });
    });

    it("rejects on error response", async () => {
      const { client, stdin, stdout } = createClient();
      const written: string[] = [];
      stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

      const promise = client.request("test.method");

      await new Promise((r) => setTimeout(r, 10));
      const sent = JSON.parse(written[0]);
      stdout.write(JSON.stringify({ id: sent.id, error: { code: -1, message: "fail" } }) + "\n");

      await expect(promise).rejects.toThrow("RPC error (-1): fail");
    });

    it("rejects on timeout", async () => {
      const { client } = createClient(50);
      await expect(client.request("slow.method")).rejects.toThrow("RPC timeout");
    });

    it("rejects when client is marked closed", async () => {
      const { client, stdout } = createClient();
      // Simulate close by ending the stream and waiting for readline close
      stdout.push(null);
      await new Promise((r) => setTimeout(r, 50));
      expect(client.isClosed).toBe(true);
      await expect(client.request("test")).rejects.toThrow("closed");
    });
  });

  describe("notify", () => {
    it("sends notification without id", () => {
      const { client, stdin } = createClient();
      const written: string[] = [];
      stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

      client.notify("test.notify", { data: 1 });

      const sent = JSON.parse(written[0]);
      expect(sent.method).toBe("test.notify");
      expect(sent.params).toEqual({ data: 1 });
      expect(sent.id).toBeUndefined();
    });
  });

  describe("notification handler", () => {
    it("routes notifications to registered handler", async () => {
      const { client, stdout } = createClient();
      const handler = vi.fn();
      client.onNotification("item.update", handler);

      stdout.write(JSON.stringify({ method: "item.update", params: { text: "hi" } }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith({ text: "hi" });
    });

    it("ignores notifications without handler", async () => {
      const { client, stdout } = createClient();
      stdout.write(JSON.stringify({ method: "unknown.event", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 10));
      // Should not throw
    });
  });

  describe("server request handler", () => {
    it("routes server requests and sends response", async () => {
      const { client, stdin, stdout } = createClient();
      const written: string[] = [];
      stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

      client.onServerRequest("approval.request", () => ({ decision: "accept" }));

      stdout.write(JSON.stringify({ id: 99, method: "approval.request", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const response = JSON.parse(written[0]);
      expect(response.id).toBe(99);
      expect(response.result).toEqual({ decision: "accept" });
    });

    it("auto-approves unhandled server requests", async () => {
      const { client, stdin, stdout } = createClient();
      const written: string[] = [];
      stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

      stdout.write(JSON.stringify({ id: 100, method: "unknown.approval", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const response = JSON.parse(written[0]);
      expect(response.id).toBe(100);
      expect(response.result).toEqual({ decision: "accept", action: "accept" });
    });
  });

  describe("rejectAll", () => {
    it("rejects all pending requests", async () => {
      const { client } = createClient(5000);
      const p1 = client.request("method1");
      const p2 = client.request("method2");

      client.rejectAll("shutdown");

      await expect(p1).rejects.toThrow("shutdown");
      await expect(p2).rejects.toThrow("shutdown");
    });
  });

  describe("handleLine", () => {
    it("handles malformed JSON gracefully", async () => {
      const { stdout } = createClient();
      stdout.write("not json\n");
      await new Promise((r) => setTimeout(r, 10));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("unparseable"));
    });

    it("ignores empty lines", async () => {
      const { stdout } = createClient();
      stdout.write("\n");
      stdout.write("   \n");
      await new Promise((r) => setTimeout(r, 10));
      // Should not log warnings
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("warns on response for unknown request id", async () => {
      const { stdout } = createClient();
      stdout.write(JSON.stringify({ id: 999, result: "orphan" }) + "\n");
      await new Promise((r) => setTimeout(r, 10));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown id=999"));
    });

    it("warns on unrecognized message structure", async () => {
      const { stdout } = createClient();
      // Message with no id, no method, no result, no error — falls through all branches
      stdout.write(JSON.stringify({ data: "something" }) + "\n");
      await new Promise((r) => setTimeout(r, 10));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("unrecognized message"));
    });
  });

  describe("notification handler error", () => {
    it("catches and logs errors thrown by notification handlers", async () => {
      const { client, stdout } = createClient();
      client.onNotification("bad.event", () => {
        throw new Error("handler exploded");
      });

      stdout.write(JSON.stringify({ method: "bad.event", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("notification handler error (bad.event)"));
    });
  });

  describe("server request handler error", () => {
    it("catches handler error and falls back to auto-approve", async () => {
      const { client, stdin, stdout } = createClient();
      const written: string[] = [];
      stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

      client.onServerRequest("fail.request", () => {
        throw new Error("handler kaboom");
      });

      stdout.write(JSON.stringify({ id: 50, method: "fail.request", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("server request handler error (fail.request)"),
      );
      // Should still send a response with fallback accept
      const response = JSON.parse(written[0]);
      expect(response.id).toBe(50);
      expect(response.result).toEqual({ decision: "accept" });
    });
  });

  describe("stdin error handling", () => {
    it("marks client closed and rejects pending on stdin error", async () => {
      const { client, stdin } = createClient(5000);
      const promise = client.request("pending.method");
      // Attach a catch handler before emitting error to prevent unhandled rejection
      const caught = promise.catch((err: Error) => err);

      // Emit an error on stdin
      stdin.emit("error", new Error("pipe broken"));
      await new Promise((r) => setTimeout(r, 10));

      expect(client.isClosed).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("stdin error: pipe broken"));
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("stdin error: pipe broken");
    });

    it("does not log when stdin error occurs after close", async () => {
      const { client, stdin, stdout } = createClient();
      // Close the client first
      stdout.push(null);
      await new Promise((r) => setTimeout(r, 50));
      expect(client.isClosed).toBe(true);

      mockLogger.warn.mockClear();
      stdin.emit("error", new Error("late error"));
      await new Promise((r) => setTimeout(r, 10));

      // The warn about "stdin error" should NOT be called because closed was already true
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining("stdin error"));
    });
  });

  describe("writeLine error handling", () => {
    it("catches write errors and logs them", () => {
      const { client, stdin } = createClient();
      // Override stdin.write to throw
      stdin.write = () => {
        throw new Error("write failed");
      };

      // notify calls writeLine internally
      client.notify("test.event", { data: 1 });

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("write error"));
    });
  });
});
