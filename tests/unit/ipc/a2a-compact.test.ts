import { describe, it, expect, beforeEach } from "vitest";

/**
 * Unit test for A2A-path session respawn detection.
 *
 * Verifies that when the provider sessionId changes (respawn),
 * the a2aContextInjected flag is cleared so bridge context is re-injected.
 */

interface SessionInfo {
  sessionId: string;
  alive: boolean;
  cwd: string;
  model?: string;
}

function detectA2aRespawn(
  syntheticId: string,
  sessionInfo: SessionInfo | null,
  a2aContextInjected: Set<string>,
  lastA2aProviderSid: Map<string, string>,
): void {
  const prevA2aSid = lastA2aProviderSid.get(syntheticId);
  if (prevA2aSid && (!sessionInfo || !sessionInfo.alive)) {
    a2aContextInjected.delete(syntheticId);
    lastA2aProviderSid.delete(syntheticId);
  }
  if (sessionInfo && prevA2aSid && sessionInfo.sessionId !== prevA2aSid) {
    a2aContextInjected.delete(syntheticId);
    lastA2aProviderSid.delete(syntheticId);
  }
}

describe("A2A path: session respawn detection", () => {
  let a2aContextInjected: Set<string>;
  let lastA2aProviderSid: Map<string, string>;
  const SYNTHETIC_ID = "agent-a:default";
  const PROVIDER_SID_V1 = "cli-session-001";
  const PROVIDER_SID_V2 = "cli-session-002";

  beforeEach(() => {
    a2aContextInjected = new Set<string>();
    lastA2aProviderSid = new Map<string, string>();
  });

  it("re-injects when provider sessionId changes (respawn)", () => {
    a2aContextInjected.add(SYNTHETIC_ID);
    lastA2aProviderSid.set(SYNTHETIC_ID, PROVIDER_SID_V1);

    const respawnedSession: SessionInfo = {
      sessionId: PROVIDER_SID_V2,
      alive: true,
      cwd: "/tmp",
    };

    detectA2aRespawn(SYNTHETIC_ID, respawnedSession, a2aContextInjected, lastA2aProviderSid);

    expect(a2aContextInjected.has(SYNTHETIC_ID)).toBe(false);
    expect(lastA2aProviderSid.has(SYNTHETIC_ID)).toBe(false);

    const isFirstA2a = !a2aContextInjected.has(SYNTHETIC_ID);
    expect(isFirstA2a).toBe(true);
  });

  it("re-injects when getSessionInfo() returns null with a previously tracked SID", () => {
    a2aContextInjected.add(SYNTHETIC_ID);
    lastA2aProviderSid.set(SYNTHETIC_ID, PROVIDER_SID_V1);

    detectA2aRespawn(SYNTHETIC_ID, null, a2aContextInjected, lastA2aProviderSid);

    expect(a2aContextInjected.has(SYNTHETIC_ID)).toBe(false);
    expect(lastA2aProviderSid.has(SYNTHETIC_ID)).toBe(false);
  });

  it("does NOT re-inject when session is alive and ID matches", () => {
    a2aContextInjected.add(SYNTHETIC_ID);
    lastA2aProviderSid.set(SYNTHETIC_ID, PROVIDER_SID_V1);

    const aliveSession: SessionInfo = {
      sessionId: PROVIDER_SID_V1,
      alive: true,
      cwd: "/tmp",
    };

    detectA2aRespawn(SYNTHETIC_ID, aliveSession, a2aContextInjected, lastA2aProviderSid);

    expect(a2aContextInjected.has(SYNTHETIC_ID)).toBe(true);
    expect(lastA2aProviderSid.has(SYNTHETIC_ID)).toBe(true);
  });

  it("does NOT clear when null but no prior SID tracked (first-time scenario)", () => {
    a2aContextInjected.add(SYNTHETIC_ID);

    detectA2aRespawn(SYNTHETIC_ID, null, a2aContextInjected, lastA2aProviderSid);

    expect(a2aContextInjected.has(SYNTHETIC_ID)).toBe(true);
  });

  it("clears flag when A2A session is dead (alive:false)", () => {
    a2aContextInjected.add(SYNTHETIC_ID);
    lastA2aProviderSid.set(SYNTHETIC_ID, PROVIDER_SID_V1);

    const deadSession: SessionInfo = {
      sessionId: PROVIDER_SID_V1,
      alive: false,
      cwd: "/tmp",
    };

    detectA2aRespawn(SYNTHETIC_ID, deadSession, a2aContextInjected, lastA2aProviderSid);

    expect(a2aContextInjected.has(SYNTHETIC_ID)).toBe(false);
    expect(lastA2aProviderSid.has(SYNTHETIC_ID)).toBe(false);
  });
});
