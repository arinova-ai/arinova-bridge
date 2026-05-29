import { describe, it, expect, afterEach } from "vitest";
import { initDb } from "../../../src/codex/db.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("initDb", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates the directory when it does not exist", () => {
    tmpDir = path.join(tmpdir(), `db-test-${Date.now()}`);
    const nested = path.join(tmpDir, "sub", "deep");
    const dbPath = path.join(nested, "bridge.db");

    expect(existsSync(nested)).toBe(false);
    const db = initDb(dbPath);
    expect(existsSync(nested)).toBe(true);

    // Verify db works
    db.upsertConversation("c1", { status: "ready" });
    expect(db.getConversation("c1")).not.toBeNull();
  });

  it("getRunningConversations returns busy conversations", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "db-test-"));
    const db = initDb(path.join(tmpDir, "bridge.db"));

    db.upsertConversation("c1", { status: "busy" });
    db.upsertConversation("c2", { status: "ready" });
    db.upsertConversation("c3", { status: "busy" });

    const running = db.getRunningConversations();
    expect(running).toHaveLength(2);
    expect(running.map((c) => c.convId).sort()).toEqual(["c1", "c3"]);
  });

  it("getAllConversations returns conversations with threadId", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "db-test-"));
    const db = initDb(path.join(tmpDir, "bridge.db"));

    db.upsertConversation("c1", { threadId: "t1", status: "ready" });
    db.upsertConversation("c2", { status: "ready" }); // no threadId
    db.upsertConversation("c3", { threadId: "t3", status: "done" });

    const all = db.getAllConversations();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.convId).sort()).toEqual(["c1", "c3"]);
  });

  it("saveRateLimitCache and loadRateLimitCache round-trip", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "db-test-"));
    const db = initDb(path.join(tmpDir, "bridge.db"));

    expect(db.loadRateLimitCache()).toBeNull();

    db.saveRateLimitCache('{"limit":100}');
    expect(db.loadRateLimitCache()).toBe('{"limit":100}');

    db.saveRateLimitCache('{"limit":200}');
    expect(db.loadRateLimitCache()).toBe('{"limit":200}');
  });

  it("updateStatus changes the status of a conversation", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "db-test-"));
    const db = initDb(path.join(tmpDir, "bridge.db"));

    db.upsertConversation("c1", { status: "ready" });
    db.updateStatus("c1", "busy");

    const conv = db.getConversation("c1");
    expect(conv!.status).toBe("busy");
  });
});
