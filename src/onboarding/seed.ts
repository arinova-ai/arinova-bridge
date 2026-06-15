import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "../util/logger.js";

/**
 * Server-authored first-touch seed carried on the permanent-token `auth_ok`
 * frame (OB-11 §5.7). The bridge *consumes* this to drive a single deterministic
 * opening turn — it never invents one.
 *
 * Mirrored locally (cf. `claude/tool-call-reporting.ts`, which mirrors the SDK's
 * `ToolCallReport`) so the bridge compiles against any installed `agent-sdk`
 * version. The seed is read via {@link SeedCapableAgent.getOnboardingSeed},
 * available from the agent-sdk release that ships OB-11; on older SDKs the
 * method is simply absent and the seeded turn no-ops.
 */
export interface OnboardingSeed {
  kind: "first_touch_opening";
  /** Process-level dedup key, shaped `onboarding:<tokenId>`. */
  seedId: string;
  agentId: string;
  action: string;
  /** Deterministic prompt body fed to the provider for the opening turn. */
  prompt: string;
}

/**
 * Structural view of the bits of `ArinovaAgent` the seeded turn needs. Declaring
 * `getOnboardingSeed` optional lets the bridge build & run against an SDK that
 * predates OB-11 (the method is absent → seed is `null` → no opening turn).
 */
export interface SeedCapableAgent {
  getOnboardingSeed?(): OnboardingSeed | null;
}

/**
 * Read the onboarding seed from an agent, tolerating SDKs that predate OB-11.
 *
 * The parameter is `unknown` on purpose: the installed `@arinova-ai/agent-sdk`
 * may or may not declare `getOnboardingSeed` depending on its version. Typing it
 * as {@link SeedCapableAgent} (an all-optional "weak" type) would trip
 * TypeScript's weak-type detection when the bridge builds against an older SDK
 * whose `ArinovaAgent` lacks the method entirely (TS2559). We duck-type instead,
 * so the bridge compiles and no-ops on old SDKs and lights up once the OB-11 SDK
 * is published and the dependency is bumped.
 */
export function readOnboardingSeed(agent: unknown): OnboardingSeed | null {
  const seedable = agent as Partial<SeedCapableAgent> | null | undefined;
  return seedable?.getOnboardingSeed?.() ?? null;
}

// ---------------------------------------------------------------------------
// OB-4: create / reuse the onboarding conversation
// ---------------------------------------------------------------------------

/**
 * Create or reuse the agent's onboarding conversation (OB-4,
 * `POST /api/v1/agents/{agentId}/conversations` with `type=onboarding`).
 *
 * The endpoint is idempotent server-side — a unique index guarantees at most one
 * onboarding conversation per agent+owner — so repeated calls (or a racing
 * reconnect) converge on the same conversation. Returns the conversation id, or
 * `null` if the server is unreachable or rejects (the caller then skips the
 * opening turn without marking the seed consumed, so a later boot can retry).
 */
export async function createOnboardingConversation(
  serverUrl: string,
  botToken: string,
  agentId: string,
  logger: Logger,
): Promise<string | null> {
  const httpUrl = serverUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const url = `${httpUrl}/api/v1/agents/${agentId}/conversations`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "onboarding" }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(`Onboarding conversation API returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { conversationId?: string };
    return data.conversationId ?? null;
  } catch (err) {
    logger.warn(`Onboarding conversation API unreachable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// AC8.9: persisted seedId dedup (survives process restart)
// ---------------------------------------------------------------------------

const DEFAULT_SEED_DIR = path.join(homedir(), ".arinova-bridge", "onboarding");
const SEED_FILE = "seeds.json";

interface SeedRecord {
  seedIds: string[];
}

function readSeedIds(dir: string): Set<string> {
  try {
    const raw = readFileSync(path.join(dir, SEED_FILE), "utf8");
    const parsed = JSON.parse(raw) as SeedRecord;
    return new Set(parsed.seedIds ?? []);
  } catch {
    // Missing/corrupt file → treat as "nothing seeded yet".
    return new Set();
  }
}

/**
 * True if this `seedId` was already consumed by a prior run. Backed by an
 * on-disk record so dedup holds across a process restart — defence-in-depth
 * behind the server's first-connect gate (OB-10) and OB-4's conversation
 * uniqueness.
 */
export function hasSeedRun(seedId: string, dir: string = DEFAULT_SEED_DIR): boolean {
  return readSeedIds(dir).has(seedId);
}

/** Record a `seedId` as consumed, persisting it for cross-restart dedup. */
export function markSeedRun(seedId: string, logger: Logger, dir: string = DEFAULT_SEED_DIR): void {
  const seeds = readSeedIds(dir);
  if (seeds.has(seedId)) return;
  seeds.add(seedId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, SEED_FILE),
      JSON.stringify({ seedIds: [...seeds] } satisfies SeedRecord, null, 2),
      "utf8",
    );
  } catch (err) {
    logger.warn(`Failed to persist onboarding seed dedup for ${seedId}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// AC8.8: the deterministic seeded opening turn
// ---------------------------------------------------------------------------

export interface OnboardingSeedTurnDeps {
  logger: Logger;
  /** Create/reuse the onboarding conversation (OB-4). Returns its id or null. */
  createConversation: (agentId: string) => Promise<string | null>;
  /** Run exactly one provider turn for `prompt`; returns the assistant text. */
  runTurn: (prompt: string) => Promise<string>;
  /** Deliver the produced greeting to the onboarding conversation. */
  sendMessage: (conversationId: string, content: string) => Promise<void>;
  /** Dedup hooks — overridable for tests; default to the disk-backed store. */
  hasSeedRun?: (seedId: string) => boolean;
  markSeedRun?: (seedId: string) => void;
}

/**
 * Run the one-time deterministic opening turn for a first-touch seed (AC8.8).
 *
 * Ordering is strict and load-bearing: dedup → create/reuse conversation (OB-4)
 * → one synthetic provider turn grounded in the already-injected onboarding
 * knowledge → deliver the greeting → mark the seed consumed. The seed is marked
 * **only after a successful send**, so a transient failure (server down, empty
 * output) leaves it un-consumed and retryable on the next boot.
 *
 * The caller guarantees this runs *after* knowledge injection; combined with the
 * server's first-connect gate (OB-10) and the persisted `seedId` dedup, the
 * opening turn fires exactly once per agent and never on a reconnect.
 */
export async function runOnboardingSeedTurn(seed: OnboardingSeed, deps: OnboardingSeedTurnDeps): Promise<void> {
  const seedHasRun = deps.hasSeedRun ?? ((id) => hasSeedRun(id));
  const seedMarkRun = deps.markSeedRun ?? ((id) => markSeedRun(id, deps.logger));

  if (seedHasRun(seed.seedId)) {
    deps.logger.info(`[onboarding] seed ${seed.seedId} already consumed — skipping opening turn`);
    return;
  }

  const conversationId = await deps.createConversation(seed.agentId);
  if (!conversationId) {
    deps.logger.warn(
      `[onboarding] could not create/reuse onboarding conversation for seed ${seed.seedId} — skipping (will retry next boot)`,
    );
    return;
  }

  const greeting = (await deps.runTurn(seed.prompt)).trim();
  if (!greeting) {
    deps.logger.warn(
      `[onboarding] opening turn produced no output for seed ${seed.seedId} — not sending, leaving seed unconsumed`,
    );
    return;
  }

  await deps.sendMessage(conversationId, greeting);
  seedMarkRun(seed.seedId);
  deps.logger.info(`[onboarding] delivered seeded opening turn for ${seed.seedId} → conversation ${conversationId}`);
}
