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
});
