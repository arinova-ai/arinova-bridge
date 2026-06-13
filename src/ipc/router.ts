import type { ActiveAgent, IpcRequest, IpcResponse, TaskRecord } from "./types.js";
import type { Provider } from "../providers/types.js";
import type { BridgeSessionStore } from "../session/bridge-session.js";
import type { SpawnManager } from "../spawn/manager.js";
import type { ForkManager } from "../fork/manager.js";
import { runMessagePipeline, clearContextInjected } from "../pipeline/message-pipeline.js";
import { createLogger } from "../util/logger.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const log = createLogger("a2a");

const A2A_PREFIX = "a2a:";
const MAX_DEPTH = 1;
const MAX_HISTORY = 50;

/**
 * Per-agent serialization for provider calls. Both the WS task path
 * (index.ts onTask) and the A2A path (deliverToAgent) acquire this before
 * invoking the provider, so a WS-task directSend() cannot abort an
 * in-flight A2A turn (and vice versa). agent-sdk's agentWideLock only
 * covers WS-originating tasks; A2A lives entirely in bridge and needs this
 * layer to share exclusion with it.
 *
 * Bridge is transport-only — stuck detection is owned by rust-server
 * (CHAT-HEARTBEAT-DETECTION). A previous wall-clock force-release lived
 * here and was removed because it false-positived on legit long streams
 * and duplicated the backend's source-of-truth signal.
 */
const agentSendChains = new Map<string, Promise<unknown>>();

export function runExclusiveOnAgent<T>(
  agentName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = agentSendChains.get(agentName) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  agentSendChains.set(agentName, next.catch(() => undefined));
  return next;
}

/** Clear A2A-specific context-injection tracking (delegates to pipeline). */
export function clearA2aContextInjected(sessionId: string): void {
  // The pipeline now owns the shared tracking state; this is kept as a
  // compatibility shim so callers in index.ts don't need to change.
  // Pipeline's clearContextInjected already covers both Chat + A2A.
}

/**
 * Query the sender agent's long-term memories via Arinova CLI.
 * Returns formatted memory context string, or undefined if no results / error.
 */
async function querySenderMemories(source: string, content: string): Promise<string | undefined> {
  // Skip non-agent sources (spawn, fork, cli)
  if (!source || source === "cli" || source.includes(":")) return undefined;

  try {
    const queryText = content.length > 200 ? content.slice(0, 200) : content;
    const { stdout } = await execFileAsync("arinova", [
      "--profile", source,
      "--json",
      "memory", "query",
      "--query", queryText,
      "--limit", "10",
    ], { timeout: 10_000 });

    const memories = JSON.parse(stdout);
    if (!Array.isArray(memories) || memories.length === 0) return undefined;

    const lines = memories.map((m: { content?: string; title?: string }) =>
      m.title ? `- ${m.title}: ${m.content ?? ""}` : `- ${m.content ?? ""}`
    );
    return `[Sender memories — from ${source}]\n${lines.join("\n")}`;
  } catch (err) {
    log.warn(`memory query for ${source} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function parseA2aDepth(conversationId: string): number {
  if (!conversationId.startsWith(A2A_PREFIX)) return 0;
  const parts = conversationId.split(":");
  return parseInt(parts[1], 10) || 0;
}

export interface DeliverResult {
  text: string;
  durationMs: number;
}

/**
 * Deliver a message to a target agent, processing it as if a user sent it.
 * Sessions are auto-created on first delivery and reused for subsequent calls.
 */
export async function deliverToAgent(
  target: ActiveAgent,
  content: string,
  opts?: { source?: string; sourceConversationId?: string; timeoutMs?: number; cwd?: string; model?: string; bridgeSessionStore?: BridgeSessionStore; onLog?: (text: string) => void },
): Promise<DeliverResult> {
  const currentDepth = opts?.sourceConversationId
    ? parseA2aDepth(opts.sourceConversationId)
    : 0;
  if (currentDepth >= MAX_DEPTH) {
    throw new Error("A2A recursion limit reached");
  }

  const from = opts?.source ?? "cli";
  const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;
  log.info(`${from} → ${target.name}: ${preview}`);

  // Use the same session as Chat — single session per agent
  const syntheticId = `${target.name}:default`;
  const start = Date.now();

  let handled = false;
  let responseText = "";

  const cmdResult = await target.commandHandler.handle(content, {
    conversationId: syntheticId,
    sendChunk: (text) => { responseText += text; },
    sendComplete: (text) => { responseText = text; },
    sendError: (text) => { responseText = `Error: ${text}`; },
    uploadFile: async () => ({ url: "", fileName: "", fileType: "", fileSize: 0 }),
  });

  handled = cmdResult.handled;

  if (!handled) {
    const cwd = opts?.cwd ?? target.agentConfig.cwd;
    const model = opts?.model ?? target.agentConfig.model;

    const controller = new AbortController();
    const timeout = opts?.timeoutMs ?? 600_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      // Query sender's long-term memories (A2A only, regardless of bridgeSessionStore)
      // Run this outside the per-agent send lock — it's a CLI subprocess call
      // against the sender, unrelated to the target's Claude process.
      let extraContext: string | undefined;
      if (from !== "cli") {
        extraContext = await querySenderMemories(from, content);
      }

      await runExclusiveOnAgent(target.name, async () => {
        if (opts?.bridgeSessionStore) {
          // Full pipeline: context injection, recording, auto-compact
          const result = await runMessagePipeline({
            provider: target.provider,
            bridgeSessionStore: opts.bridgeSessionStore,
            sessionId: syntheticId,
            content,
            agentName: target.name,
            cwd,
            model,
            systemPrompt: target.agentConfig.systemPrompt,
            compactModel: target.agentConfig.compactModel,
            onChunk: (text) => { responseText += text; opts?.onLog?.(text); },
            signal: controller.signal,
            queue: true,
            extraContext,
            senderName: from,
            // `from` is the source agent's handle for A2A deliveries (only
            // "cli" is a non-agent source), so attribute the message to the
            // real agent rather than leaving it unattributed.
            senderAgentName: from !== "cli" ? from : undefined,
            reportToolCall: (report) => target.agent.reportToolCall(report),
          });
          responseText = result.text;
        } else {
          // Lightweight path: no session store (e.g. tests, raw IPC)
          // Still inject sender memories as bridgeSessionContext if available
          const result = await target.provider.sendMessage({
            conversationId: syntheticId,
            content,
            cwd,
            model,
            systemPrompt: target.agentConfig.systemPrompt,
            onChunk: (text) => { responseText += text; opts?.onLog?.(text); },
            signal: controller.signal,
            queue: true,
            bridgeSessionContext: extraContext,
            reportToolCall: (report) => target.agent.reportToolCall(report),
          });
          responseText = result.text;
        }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const durationMs = Date.now() - start;
  log.info(`${from} → ${target.name}: done (${durationMs}ms)`);
  return { text: responseText, durationMs };
}

// --- Watch subscribers ---
type WatchWriter = (line: string) => void;
const watchSubscribers = new Set<WatchWriter>();

export function notifyWatch(record: TaskRecord): void {
  const line = JSON.stringify(record);
  for (const writer of watchSubscribers) {
    try { writer(line); } catch { /* subscriber gone */ }
  }
}

// --- Task history ---
const taskHistory: TaskRecord[] = [];

export function recordTask(record: TaskRecord): void {
  taskHistory.push(record);
  if (taskHistory.length > MAX_HISTORY) taskHistory.shift();
  notifyWatch(record);
}

// --- Router ---

function findAgent(agents: ActiveAgent[], name: string): ActiveAgent | undefined {
  return agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

function agentNotFound(id: number, name: string, agents: ActiveAgent[]): IpcResponse {
  const names = agents.map((a) => a.name).join(", ");
  return { id, error: { code: 1, message: `Agent "${name}" not found. Available: ${names}` } };
}

export function createIpcRouter(
  agents: ActiveAgent[],
  providers: Map<string, Provider>,
  bridgeSessionStore?: BridgeSessionStore,
  spawnManager?: SpawnManager,
  forkManager?: ForkManager,
): (req: IpcRequest) => Promise<IpcResponse> {
  return async (req: IpcRequest): Promise<IpcResponse> => {
    switch (req.method) {
      case "list-agents":
        return handleListAgents(req.id, agents);
      case "deliver":
        return handleDeliver(req.id, agents, req.params, bridgeSessionStore);
      case "agent-status":
        return handleAgentStatus(req.id, agents, req.params);
      case "ping":
        return handlePing(req.id, agents, req.params);
      case "agent-cost":
        return handleAgentCost(req.id, agents, req.params);
      case "agent-stop":
        return handleAgentStop(req.id, agents, req.params);
      case "agent-reset":
        return await handleAgentReset(req.id, agents, req.params);
      case "handoff":
        return handleHandoff(req.id, agents, req.params);
      case "history":
        return handleHistory(req.id, req.params);
      case "spawn-add":
        return handleSpawnAdd(req.id, agents, req.params, spawnManager);
      case "spawn-list":
        return handleSpawnList(req.id, agents, req.params, spawnManager);
      case "spawn-cancel":
        return handleSpawnCancel(req.id, req.params, spawnManager);
      case "spawn-result":
        return handleSpawnResult(req.id, req.params, spawnManager);
      case "spawn-logs":
        return handleSpawnLogs(req.id, req.params, spawnManager);
      case "fork-add":
        return handleForkAdd(req.id, agents, req.params, forkManager);
      case "fork-list":
        return handleForkList(req.id, agents, req.params, forkManager);
      case "fork-cancel":
        return handleForkCancel(req.id, req.params, forkManager);
      case "watch":
        // Watch is handled specially by the server (streaming), not here.
        // Return immediate ack.
        return { id: req.id, result: { streaming: true } };
      default: {
        const unknown = req as { id: number; method: string };
        return { id: unknown.id, error: { code: -32601, message: `Unknown method: ${unknown.method}` } };
      }
    }
  };
}

export function subscribeWatch(writer: WatchWriter): () => void {
  watchSubscribers.add(writer);
  return () => { watchSubscribers.delete(writer); };
}

// --- Handlers ---

function handleListAgents(id: number, agents: ActiveAgent[]): IpcResponse {
  const list = agents.map((a) => ({
    name: a.name,
    provider: a.provider.id,
    providerDisplayName: a.provider.displayName,
    cwd: a.agentConfig.cwd,
    model: a.agentConfig.model ?? "default",
  }));
  return { id, result: list };
}

async function handleDeliver(
  id: number,
  agents: ActiveAgent[],
  params: { target: string; content: string; source?: string; cwd?: string; model?: string; wait?: boolean },
  bridgeSessionStore?: BridgeSessionStore,
): Promise<IpcResponse> {
  const target = findAgent(agents, params.target);
  if (!target) return agentNotFound(id, params.target, agents);

  const deliverOpts = { source: params.source, cwd: params.cwd, model: params.model, bridgeSessionStore };

  // Fire-and-forget mode
  if (params.wait === false) {
    deliverToAgent(target, params.content, deliverOpts).catch((err) => {
      log.warn(`fire-and-forget deliver to ${target.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { id, result: { agent: target.name, queued: true } };
  }

  try {
    const result = await deliverToAgent(target, params.content, deliverOpts);
    return { id, result: { agent: target.name, text: result.text, durationMs: result.durationMs } };
  } catch (err) {
    return { id, error: { code: 2, message: err instanceof Error ? err.message : String(err) } };
  }
}

function handleAgentStatus(
  id: number,
  agents: ActiveAgent[],
  params: { target: string },
): IpcResponse {
  const target = findAgent(agents, params.target);
  if (!target) return agentNotFound(id, params.target, agents);

  const provider = target.provider;
  const allSessions = provider.listSessions();
  const agentSessions = allSessions.filter((s) => s.conversationId.startsWith(`${target.name}:`));

  return {
    id,
    result: {
      name: target.name,
      provider: provider.id,
      providerDisplayName: provider.displayName,
      cwd: target.agentConfig.cwd,
      model: target.agentConfig.model ?? "default",
      activeSessions: agentSessions.length,
      sessions: agentSessions.map((s) => ({
        sessionId: s.sessionId.slice(0, 12),
        status: s.status,
        cwd: s.cwd,
        model: s.model ?? "default",
      })),
    },
  };
}

function handlePing(
  id: number,
  agents: ActiveAgent[],
  params: { target: string },
): IpcResponse {
  const target = findAgent(agents, params.target);
  if (!target) return agentNotFound(id, params.target, agents);

  const sessions = target.provider.listSessions();
  const agentSessions = sessions.filter((s) => s.conversationId.startsWith(`${target.name}:`));
  const hasActiveSession = agentSessions.some((s) => s.alive !== false);

  return {
    id,
    result: {
      agent: target.name,
      alive: true,
      provider: target.provider.id,
      activeSessions: agentSessions.length,
      hasActiveSession,
    },
  };
}

function handleAgentCost(
  id: number,
  agents: ActiveAgent[],
  params: { target?: string },
): IpcResponse {
  const targets = params.target
    ? (() => { const a = findAgent(agents, params.target); return a ? [a] : null; })()
    : agents;

  if (!targets) return agentNotFound(id, params.target!, agents);

  const costs = targets.map((a) => {
    const sessions = a.provider.listSessions()
      .filter((s) => s.conversationId.startsWith(`${a.name}:`));

    let totalCostUsd = 0;
    let totalInput = 0;
    let totalOutput = 0;

    for (const s of sessions) {
      const cost = a.provider.getCostInfo(s.conversationId);
      if (cost) {
        totalCostUsd += cost.totalCostUsd ?? 0;
        totalInput += cost.inputTokens ?? 0;
        totalOutput += cost.outputTokens ?? 0;
      }
    }

    return {
      agent: a.name,
      provider: a.provider.id,
      totalCostUsd,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      sessions: sessions.length,
    };
  });

  return { id, result: params.target ? costs[0] : costs };
}

function handleAgentStop(
  id: number,
  agents: ActiveAgent[],
  params: { target: string },
): IpcResponse {
  const target = findAgent(agents, params.target);
  if (!target) return agentNotFound(id, params.target, agents);

  const sessions = target.provider.listSessions()
    .filter((s) => s.conversationId.startsWith(`${target.name}:`));

  let interrupted = 0;
  for (const s of sessions) {
    try {
      target.provider.interrupt(s.conversationId);
      interrupted++;
    } catch { /* best effort */ }
  }

  return { id, result: { agent: target.name, interrupted, totalSessions: sessions.length } };
}

async function handleAgentReset(
  id: number,
  agents: ActiveAgent[],
  params: { target: string },
): Promise<IpcResponse> {
  const target = findAgent(agents, params.target);
  if (!target) return agentNotFound(id, params.target, agents);

  const sessions = target.provider.listSessions()
    .filter((s) => s.conversationId.startsWith(`${target.name}:`));

  let reset = 0;
  for (const s of sessions) {
    try {
      await target.provider.resetSession(s.conversationId, { restartProcess: true });
      clearContextInjected(s.conversationId);
      reset++;
    } catch { /* best effort */ }
  }

  return { id, result: { agent: target.name, reset, totalSessions: sessions.length } };
}

function handleHandoff(
  id: number,
  agents: ActiveAgent[],
  params: { from: string; to: string },
): IpcResponse {
  const fromAgent = findAgent(agents, params.from);
  if (!fromAgent) return agentNotFound(id, params.from, agents);

  const toAgent = findAgent(agents, params.to);
  if (!toAgent) return agentNotFound(id, params.to, agents);

  if (fromAgent.name === toAgent.name) {
    return { id, error: { code: 3, message: "Cannot handoff to the same agent" } };
  }

  const fromSessions = fromAgent.provider.listSessions()
    .filter((s) => s.conversationId.startsWith(`${fromAgent.name}:`));

  if (fromSessions.length === 0) {
    return { id, error: { code: 4, message: `Agent "${fromAgent.name}" has no active sessions to hand off` } };
  }

  // Transfer cwd and model from the most recent session
  const latest = fromSessions[fromSessions.length - 1];
  const handoffCwd = latest.cwd || fromAgent.agentConfig.cwd;
  const handoffModel = latest.model;

  // Set overrides on the target agent's command handler
  // Use a well-known handoff session ID so the next message in that conversation uses these settings
  const handoffInfo = {
    from: fromAgent.name,
    to: toAgent.name,
    cwd: handoffCwd,
    model: handoffModel ?? toAgent.agentConfig.model ?? "default",
    sessionCount: fromSessions.length,
  };

  return { id, result: handoffInfo };
}

function handleHistory(
  id: number,
  params: { target?: string; limit?: number },
): IpcResponse {
  const limit = params.limit ?? 10;
  let filtered = taskHistory;

  if (params.target) {
    filtered = taskHistory.filter((r) => r.agent.toLowerCase() === params.target!.toLowerCase());
  }

  const result = filtered.slice(-limit);
  return { id, result };
}

// --- Spawn Handlers ---

function handleSpawnAdd(
  id: number,
  agents: ActiveAgent[],
  params: { parentAgent: string; targetAgent: string; context: string; model?: string; cwd?: string },
  spawnManager?: SpawnManager,
): IpcResponse {
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const parent = findAgent(agents, params.parentAgent);
  if (!parent) return agentNotFound(id, params.parentAgent, agents);

  const target = findAgent(agents, params.targetAgent);
  if (!target) return agentNotFound(id, params.targetAgent, agents);

  try {
    const job = spawnManager.spawn({
      parentAgent: parent.name,
      targetAgent: target.name,
      context: params.context,
      model: params.model,
      cwd: params.cwd,
    });
    return {
      id,
      result: {
        id: job.id,
        parentAgent: job.parentAgent,
        targetAgent: job.targetAgent,
        status: job.status,
        createdAt: job.createdAt,
      },
    };
  } catch (err) {
    return { id, error: { code: 10, message: err instanceof Error ? err.message : String(err) } };
  }
}

function handleSpawnList(
  id: number,
  agents: ActiveAgent[],
  params: { agent?: string },
  spawnManager?: SpawnManager,
): IpcResponse {
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const jobs = params.agent
    ? spawnManager.listByParent(params.agent)
    : spawnManager.listAll();

  return {
    id,
    result: jobs.map((j) => ({
      id: j.id,
      parentAgent: j.parentAgent,
      targetAgent: j.targetAgent,
      status: j.status,
      durationMs: j.durationMs,
      model: j.model,
      costUsd: j.costUsd,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      contextPreview: j.context.length > 100 ? j.context.slice(0, 100) + "…" : j.context,
      resultPreview: j.result
        ? (() => {
            const firstLine = j.result.split("\n")[0];
            const truncated = firstLine.length < j.result.length || firstLine.length > 100;
            const preview = firstLine.slice(0, 100);
            return truncated ? preview + `… (${j.result.length} chars, use spawn result ${j.id})` : preview;
          })()
        : null,
    })),
  };
}

function handleSpawnCancel(
  id: number,
  params: { id: string },
  spawnManager?: SpawnManager,
): IpcResponse {
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const cancelled = spawnManager.cancel(params.id);
  if (!cancelled) {
    return { id, error: { code: 11, message: `Spawn job "${params.id}" not found or already completed` } };
  }
  return { id, result: { cancelled: true, id: params.id } };
}

function handleSpawnResult(
  id: number,
  params: { id: string },
  spawnManager?: SpawnManager,
): IpcResponse {
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const job = spawnManager.getJob(params.id);
  if (!job) {
    return { id, error: { code: 11, message: `Spawn job "${params.id}" not found` } };
  }

  return {
    id,
    result: {
      id: job.id,
      parentAgent: job.parentAgent,
      targetAgent: job.targetAgent,
      status: job.status,
      context: job.context,
      result: job.result,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      durationMs: job.durationMs,
      model: job.model,
      costUsd: job.costUsd,
    },
  };
}

function handleSpawnLogs(
  id: number,
  params: { id: string },
  spawnManager?: SpawnManager,
): IpcResponse {
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const job = spawnManager.getJob(params.id);
  if (!job) {
    return { id, error: { code: 11, message: `Spawn job "${params.id}" not found` } };
  }

  const logs = spawnManager.getLogs(params.id);
  return {
    id,
    result: {
      id: job.id,
      status: job.status,
      logs: logs.map((l) => ({ content: l.content, createdAt: l.createdAt })),
    },
  };
}

// --- Fork Handlers ---

function handleForkAdd(
  id: number,
  agents: ActiveAgent[],
  params: { agent: string; task: string; model?: string; cwd?: string },
  forkManager?: ForkManager,
): IpcResponse {
  if (!forkManager) return { id, error: { code: 5, message: "Fork manager not enabled" } };

  const agent = findAgent(agents, params.agent);
  if (!agent) return agentNotFound(id, params.agent, agents);

  try {
    const job = forkManager.fork({
      parentAgent: agent.name,
      task: params.task,
      model: params.model,
      cwd: params.cwd,
    });
    return {
      id,
      result: {
        id: job.id,
        parentAgent: job.parentAgent,
        status: job.status,
        createdAt: job.createdAt,
      },
    };
  } catch (err) {
    return { id, error: { code: 12, message: err instanceof Error ? err.message : String(err) } };
  }
}

function handleForkList(
  id: number,
  agents: ActiveAgent[],
  params: { agent?: string },
  forkManager?: ForkManager,
): IpcResponse {
  if (!forkManager) return { id, error: { code: 5, message: "Fork manager not enabled" } };

  let jobs;
  if (params.agent) {
    const agent = findAgent(agents, params.agent);
    if (!agent) return agentNotFound(id, params.agent, agents);
    jobs = forkManager.listByParent(agent.name);
  } else {
    jobs = forkManager.listAll();
  }

  return {
    id,
    result: jobs.map((j) => ({
      id: j.id,
      parentAgent: j.parentAgent,
      status: j.status,
      durationMs: j.durationMs,
      model: j.model,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      taskPreview: j.task.length > 100 ? j.task.slice(0, 100) + "…" : j.task,
      resultPreview: j.result ? (j.result.length > 100 ? j.result.slice(0, 100) + "…" : j.result) : null,
    })),
  };
}

function handleForkCancel(
  id: number,
  params: { id: string },
  forkManager?: ForkManager,
): IpcResponse {
  if (!forkManager) return { id, error: { code: 5, message: "Fork manager not enabled" } };

  const cancelled = forkManager.cancel(params.id);
  if (!cancelled) {
    return { id, error: { code: 13, message: `Fork job "${params.id}" not found or already completed` } };
  }
  return { id, result: { cancelled: true, id: params.id } };
}
