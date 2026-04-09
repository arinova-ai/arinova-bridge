import { describe, it, expect, beforeEach } from "vitest";

/**
 * Unit test for Chat-path session respawn detection.
 *
 * We test the core logic directly: when getSessionInfo() returns null
 * (provider session gone) but we previously tracked a provider session ID,
 * the contextInjectedSessions flag must be cleared so re-injection happens.
 */

interface SessionInfo {
  sessionId: string;
  alive: boolean;
  cwd: string;
  model?: string;
}

function detectRespawn(
  sessionId: string,
  sessionInfo: SessionInfo | null,
  contextInjected: Set<string>,
  lastProviderSid: Map<string, string>,
): void {
  const prevProviderSid = lastProviderSid.get(sessionId);
  if (prevProviderSid && (!sessionInfo || !sessionInfo.alive)) {
    contextInjected.delete(sessionId);
    lastProviderSid.delete(sessionId);
  }
  if (sessionInfo && prevProviderSid && sessionInfo.sessionId !== prevProviderSid) {
    contextInjected.delete(sessionId);
    lastProviderSid.delete(sessionId);
  }
}

describe("Chat path: session respawn detection", () => {
  let contextInjected: Set<string>;
  let lastProviderSid: Map<string, string>;
  const SESSION = "test-session";
  const PROVIDER_SID = "provider-abc-123";

  beforeEach(() => {
    contextInjected = new Set<string>();
    lastProviderSid = new Map<string, string>();
  });

  it("clears injected flag when getSessionInfo() returns null and provider SID was tracked", () => {
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, PROVIDER_SID);

    detectRespawn(SESSION, null, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(false);
    expect(lastProviderSid.has(SESSION)).toBe(false);

    const isFirstMessage = !contextInjected.has(SESSION);
    expect(isFirstMessage).toBe(true);
  });

  it("clears injected flag when session is not alive", () => {
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, PROVIDER_SID);

    const deadSession: SessionInfo = {
      sessionId: PROVIDER_SID,
      alive: false,
      cwd: "/tmp",
    };

    detectRespawn(SESSION, deadSession, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(false);
    expect(lastProviderSid.has(SESSION)).toBe(false);
  });

  it("clears injected flag when provider session ID changes (mid-turn respawn)", () => {
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, PROVIDER_SID);

    const newSession: SessionInfo = {
      sessionId: "provider-xyz-456",
      alive: true,
      cwd: "/tmp",
    };

    detectRespawn(SESSION, newSession, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(false);
    expect(lastProviderSid.has(SESSION)).toBe(false);
  });

  it("does NOT clear flag when session is alive and ID matches", () => {
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, PROVIDER_SID);

    const aliveSession: SessionInfo = {
      sessionId: PROVIDER_SID,
      alive: true,
      cwd: "/tmp",
    };

    detectRespawn(SESSION, aliveSession, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(true);
    expect(lastProviderSid.has(SESSION)).toBe(true);
  });

  it("does NOT clear flag when getSessionInfo() is null but no prior SID was tracked", () => {
    contextInjected.add(SESSION);

    detectRespawn(SESSION, null, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(true);
  });

  it("does NOT clear flag for Gemini idle session (alive:true, status ready)", () => {
    // Gemini's alive should be true when status is "ready" (idle).
    // Previously alive was conv.status === "busy", which caused false respawn
    // detection on every idle turn.
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, PROVIDER_SID);

    const geminiIdle: SessionInfo = {
      sessionId: PROVIDER_SID,
      alive: true, // status "ready" → alive: true (fixed)
      cwd: "/workspace",
    };

    detectRespawn(SESSION, geminiIdle, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(true);
    expect(lastProviderSid.has(SESSION)).toBe(true);
  });

  it("clears flag for Gemini error session (alive:false, status error)", () => {
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, PROVIDER_SID);

    const geminiError: SessionInfo = {
      sessionId: PROVIDER_SID,
      alive: false, // status "error" → alive: false
      cwd: "/workspace",
    };

    detectRespawn(SESSION, geminiError, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(false);
    expect(lastProviderSid.has(SESSION)).toBe(false);
  });

  it("tracks provider session ID after sendMessage and detects subsequent respawn", () => {
    // Simulate: first message succeeds → track provider SID
    // Then provider respawns → new SID → flag cleared
    contextInjected.add(SESSION);

    // After sendMessage returns, track the provider SID
    lastProviderSid.set(SESSION, PROVIDER_SID);

    // Next turn: provider has respawned with a new session
    const respawned: SessionInfo = {
      sessionId: "provider-new-999",
      alive: true,
      cwd: "/tmp",
    };

    detectRespawn(SESSION, respawned, contextInjected, lastProviderSid);

    expect(contextInjected.has(SESSION)).toBe(false);
    // After re-injection and new sendMessage, tracking resumes
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, "provider-new-999");

    // Subsequent turn: same session, no respawn
    detectRespawn(SESSION, respawned, contextInjected, lastProviderSid);
    expect(contextInjected.has(SESSION)).toBe(true);
  });

  it("handles multiple respawn cycles correctly", () => {
    // Cycle 1: inject → track
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, "sid-v1");

    // Cycle 1: process dies
    detectRespawn(SESSION, null, contextInjected, lastProviderSid);
    expect(contextInjected.has(SESSION)).toBe(false);

    // Cycle 2: re-inject → track new SID
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, "sid-v2");

    // Cycle 2: mid-turn respawn (SID changes)
    const respawned: SessionInfo = { sessionId: "sid-v3", alive: true, cwd: "/tmp" };
    detectRespawn(SESSION, respawned, contextInjected, lastProviderSid);
    expect(contextInjected.has(SESSION)).toBe(false);

    // Cycle 3: re-inject → track
    contextInjected.add(SESSION);
    lastProviderSid.set(SESSION, "sid-v3");

    // Cycle 3: alive and stable
    detectRespawn(SESSION, respawned, contextInjected, lastProviderSid);
    expect(contextInjected.has(SESSION)).toBe(true);
  });
});
