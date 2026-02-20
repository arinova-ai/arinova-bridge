import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionStore, type SessionStoreConfig } from "../../../src/claude/session-store.js";

// Mock the ClaudeProcess class — must use a class/function, not arrow
vi.mock("../../../src/claude/process.js", () => {
  return {
    ClaudeProcess: vi.fn(function (this: any) {
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.sendMessage = vi.fn(async (text: string, onText?: (t: string) => void) => {
        onText?.("reply");
        return { text: "reply", sessionId: "sid-123" };
      });
      this.isAlive = vi.fn(() => true);
      this.isBusy = vi.fn(() => false);
      this.abortTurn = vi.fn();
      this.getSessionId = vi.fn(() => "sid-123");
      this.getTotalCost = vi.fn(() => 0.05);
      this.getCwd = vi.fn(() => "/test");
      this.getModel = vi.fn(() => "sonnet");
    }),
  };
});

function createConfig(): SessionStoreConfig {
  return {
    claudePath: "claude",
    defaultCwd: "/default",
    maxSessions: 3,
    idleTimeoutMs: 600_000,
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SessionStore(createConfig(), logger);
  });

  afterEach(async () => {
    await store.stopAll();
  });

  describe("createSession", () => {
    it("creates a new session", () => {
      const entry = store.createSession("conv-1", { cwd: "/test" });
      expect(entry).toBeDefined();
      expect(entry.process).toBeDefined();
      expect(entry.cwd).toBe("/test");
      expect(entry.process.start).toHaveBeenCalled();
    });

    it("uses default cwd when not specified", () => {
      const entry = store.createSession("conv-1");
      expect(entry.cwd).toBe("/default");
    });

    it("stores model", () => {
      const entry = store.createSession("conv-1", { model: "opus" });
      expect(entry.model).toBe("opus");
    });
  });

  describe("getSession", () => {
    it("returns existing session", () => {
      store.createSession("conv-1");
      const entry = store.getSession("conv-1");
      expect(entry).toBeDefined();
    });

    it("returns undefined for non-existent session", () => {
      const entry = store.getSession("conv-999");
      expect(entry).toBeUndefined();
    });
  });

  describe("destroySession", () => {
    it("stops and removes the session", async () => {
      const entry = store.createSession("conv-1");
      await store.destroySession("conv-1");
      expect(entry.process.stop).toHaveBeenCalled();
      expect(store.getSession("conv-1")).toBeUndefined();
    });

    it("preserves session ID for resume", async () => {
      store.createSession("conv-1");
      await store.destroySession("conv-1");

      const dead = store.getDeadSession("sid-123");
      expect(dead).toBeDefined();
      expect(dead?.sessionId).toBe("sid-123");
    });

    it("no-op for non-existent session", async () => {
      await store.destroySession("conv-999");
    });
  });

  describe("resumeSession", () => {
    it("resumes with given session ID", async () => {
      store.createSession("conv-1");
      await store.destroySession("conv-1");

      const entry = await store.resumeSession("conv-1", "sid-123");
      expect(entry).not.toBeNull();
      expect(entry!.process.start).toHaveBeenCalled();
    });

    it("returns null when no session ID available", async () => {
      const entry = await store.resumeSession("conv-999");
      expect(entry).toBeNull();
    });
  });

  describe("listSessions", () => {
    it("lists active sessions", () => {
      store.createSession("conv-1");
      store.createSession("conv-2");
      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe("sid-123");
    });

    it("includes dead sessions", async () => {
      store.createSession("conv-1");
      await store.destroySession("conv-1");

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].alive).toBe(false);
    });
  });

  describe("max sessions enforcement", () => {
    it("evicts oldest idle session when at capacity", () => {
      store.createSession("conv-1");
      store.createSession("conv-2");
      store.createSession("conv-3");
      store.createSession("conv-4");

      expect(store.getSession("conv-1")).toBeUndefined();
      expect(store.getSession("conv-4")).toBeDefined();
    });
  });

  describe("stopAll", () => {
    it("stops all sessions", async () => {
      const e1 = store.createSession("conv-1");
      const e2 = store.createSession("conv-2");

      await store.stopAll();

      expect(e1.process.stop).toHaveBeenCalled();
      expect(e2.process.stop).toHaveBeenCalled();
      expect(store.getSession("conv-1")).toBeUndefined();
    });
  });

  describe("getLastSessionId", () => {
    it("returns session ID from active session", () => {
      store.createSession("conv-1");
      expect(store.getLastSessionId("conv-1")).toBe("sid-123");
    });

    it("returns undefined for unknown conversation", () => {
      expect(store.getLastSessionId("conv-999")).toBeUndefined();
    });
  });
});
