import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import { loadConfig, type ResolvedAgent } from "./config.js";
import { createProviders } from "./providers/registry.js";
import { ensureAgentCliMcpConfig, type ArinovaMcpEnv } from "./mcp/preinstalled.js";
import { CommandHandler } from "./commands/handler.js";
import { createLogger } from "./util/logger.js";
import { formatResetIn, truncate } from "./util/formatting.js";
import { getErrorMessage } from "./util/errors.js";
import { startOAuthRefreshTimer } from "./oauth/refresh-timer.js";
import { formatModelName, type HudData } from "./claude/hud-ws.js";
import { startIpcServer } from "./ipc/server.js";
import { createIpcRouter, recordTask, runExclusiveOnAgent } from "./ipc/router.js";
import type { ActiveAgent } from "./ipc/types.js";
import { BridgeSessionStore } from "./session/bridge-session.js";
import { runMessagePipeline, clearContextInjected } from "./pipeline/message-pipeline.js";
import { SpawnStore } from "./spawn/store.js";
import { SpawnManager } from "./spawn/manager.js";
import { ForkStore } from "./fork/store.js";
import { ForkManager } from "./fork/manager.js";
import { savePermanentToken } from "./onboarding/token-persistence.js";
import { fetchOnboardingKnowledge } from "./onboarding/knowledge.js";
import { homedir } from "node:os";
import path from "node:path";

const logger = createLogger("bridge");
const config = loadConfig();

logger.info(
  `Loaded config: defaultProvider=${config.defaultProvider} mcpConfigPath=${config.defaults.mcpConfigPath ?? "(none, will auto-generate)"} agents=${config.agents.length}`,
);

// Bridge session store — maintains conversation history across provider restarts
const bridgeSessionStore = new BridgeSessionStore(path.join(homedir(), ".arinova-bridge", "sessions"), logger);

// Spawn manager
const spawnStore = new SpawnStore(path.join(homedir(), ".arinova-bridge", "spawn"), logger);
const spawnManager = new SpawnManager(spawnStore);

// Fork manager
const forkStore = new ForkStore(path.join(homedir(), ".arinova-bridge", "fork"), logger);
const forkManager = new ForkManager(forkStore);

// Shared resources
const providers = await createProviders(config, logger);

if (providers.size === 0) {
  logger.error("No providers are enabled. Run `arinova-bridge setup` or check your config.");
  process.exit(1);
}

logger.info(`Enabled providers: ${Array.from(providers.keys()).join(", ")}`);

const stopRefreshTimer = startOAuthRefreshTimer(config.providers, logger);

// Rate limits are parsed inline from each PTY session's terminal status line
// (see PtyProcess.getRateLimits via getUsageInfo), so there is no separate
// per-provider HUD monitor process.

// Track all agents for shutdown
const activeAgents: ActiveAgent[] = [];

// Start all agents in parallel
const startResults = await Promise.allSettled(config.agents.map((agentConfig) => startAgent(agentConfig)));
for (let i = 0; i < startResults.length; i++) {
  const result = startResults[i];
  if (result.status === "rejected") {
    logger.error(`Failed to start agent "${config.agents[i].name}": ${result.reason}`);
  }
}

if (activeAgents.length === 0) {
  logger.error("No agents started successfully. Check config and try again.");
  process.exit(1);
}

logger.info(`Bridge started — ${activeAgents.length} agent(s): [${activeAgents.map((a) => a.name).join(", ")}]`);

// Pre-create LLM sessions so A2A works immediately after boot
for (const { name, provider, agentConfig, agent } of activeAgents) {
  const warmupId = `${name}:default`;
  provider.warmup(warmupId, {
    cwd: agentConfig.cwd,
    model: agentConfig.model,
    systemPrompt: agentConfig.systemPrompt,
    // Wire the tool-call reporter at warmup so the pre-spawned process
    // reports tool calls from the very first turn — without this, warmup
    // would create a process whose reporter is undefined and subsequent
    // sendMessage calls cannot retrofit it (opts are captured at construction).
    reportToolCall: (report) => agent.reportToolCall(report),
  });
  logger.info(`[${name}] pre-warmed session ${warmupId}`);
}

// Start IPC server for A2A communication
const ipcRouter = createIpcRouter(activeAgents, providers, bridgeSessionStore, spawnManager, forkManager);
const stopIpc = startIpcServer(ipcRouter, logger);

// Initialize spawn manager and recover stale jobs
spawnManager.setAgents(activeAgents, bridgeSessionStore);
spawnManager.recoverStale();
spawnManager.cleanupOldLogs();

// Initialize fork manager and recover stale jobs
forkManager.setAgents(activeAgents, bridgeSessionStore);
forkManager.recoverStale();

async function startAgent(agentCfg: ResolvedAgent): Promise<void> {
  const agentName = agentCfg.name;

  // Validate provider exists
  const provider = providers.get(agentCfg.provider);
  if (!provider) {
    logger.error(`agent "${agentName}": provider "${agentCfg.provider}" not found, skipping`);
    return;
  }

  // Per-agent MCP config with agent's own bot token.
  // anthropic-cli uses the file path directly via SessionStore, so skip when
  // the user explicitly set mcpConfigPath (they own that file).
  // All other providers (anthropic-sdk) read the JSON via setAgentMcpConfig,
  // so they get either the user's custom file or a generated per-agent one.
  if (provider.setAgentMcpConfig) {
    if (provider.type === "anthropic-cli" && config.defaults.mcpConfigPath) {
      // CLI provider: user-provided file is already wired via SessionStore default
    } else if (config.defaults.mcpConfigPath) {
      // Non-CLI provider: read the user's custom file
      provider.setAgentMcpConfig(agentName, config.defaults.mcpConfigPath);
    } else {
      // No user config: generate per-agent file with agent's own token
      const agentArinova: ArinovaMcpEnv = {
        botToken: agentCfg.botToken,
        serverUrl: config.arinova.serverUrl,
      };
      const userMcp = Object.keys(config.mcpServers).length > 0 ? config.mcpServers : undefined;
      const agentMcpPath = ensureAgentCliMcpConfig(agentName, logger, agentArinova, userMcp);
      if (agentMcpPath) {
        provider.setAgentMcpConfig(agentName, agentMcpPath);
      }
    }
  }
  const agentMcpEnv = {
    ARINOVA_BOT_TOKEN: agentCfg.botToken,
    ARINOVA_SERVER_URL: config.arinova.serverUrl,
  };
  for (const candidateProvider of providers.values()) {
    if (candidateProvider.setAgentMcpEnv) {
      candidateProvider.setAgentMcpEnv(agentName, agentMcpEnv);
    }
  }

  // Per-agent config override for CommandHandler
  const agentBridgeConfig = {
    ...config,
    defaultProvider: agentCfg.provider,
    defaults: { ...config.defaults, cwd: agentCfg.cwd },
  };

  const commandHandler = new CommandHandler(providers, agentBridgeConfig, bridgeSessionStore);

  // /new — full clear: wipe DB history + tracking flags
  commandHandler.onSessionClear = (conversationId) => {
    bridgeSessionStore.clear(conversationId);
    clearContextInjected(conversationId);
  };
  // /model, /compact — light reset: clear tracking flags only, preserve DB (summary + messages)
  commandHandler.onSessionReset = (conversationId) => {
    clearContextInjected(conversationId);
  };
  commandHandler.spawnManager = spawnManager;
  commandHandler.forkManager = forkManager;
  commandHandler.agentName = agentName;

  const agent = new ArinovaAgent({
    serverUrl: config.arinova.serverUrl,
    botToken: agentCfg.botToken,
    skills: commandHandler.getSkills(),
    // Single Claude session per agent means we literally cannot process
    // two tasks in parallel — cross-conv arrivals must queue rather than
    // race for the session. agent-wide gating + round-robin drain (cap 2
    // consecutive runs per conv) enforces that fairly.
    concurrencyMode: "agent-wide",
    maxConsecutivePerConversation: 2,
  });

  agent.onTask(async (ctx) => {
    const { conversationId, content } = ctx;
    // Platform cron/trigger wakeups are agent-level tasks with no
    // conversation — label them by kind so logs stay traceable.
    const taskLabel = conversationId ?? `${ctx.taskKind ?? "task"}:${ctx.taskId}`;
    const requireConversation = (api: string): string => {
      if (!conversationId) {
        throw new Error(
          `${api} unavailable: this task (${taskLabel}) is a platform wakeup with no conversation`,
        );
      }
      return conversationId;
    };
    // Single session per agent — Chat and A2A share the same context
    const sessionId = `${agentName}:default`;

    try {
      // Try command handling first
      const result = await commandHandler.handle(content, {
        conversationId: sessionId,
        sendChunk: ctx.sendChunk,
        sendComplete: ctx.sendComplete,
        sendError: ctx.sendError,
        uploadFile: ctx.uploadFile,
        attachments: ctx.attachments,
        conversationType: ctx.conversationType,
        senderUserId: ctx.senderUserId,
        senderUsername: ctx.senderUsername,
        members: ctx.members,
        fetchHistory: ctx.fetchHistory,
        // Arinova API calls use original conversationId (not session-scoped);
        // platform wakeups have none, so fail with a clear message instead
        // of hitting the API with undefined.
        listNotes: (options) => agent.listNotes(requireConversation("listNotes"), options),
        createNote: (body) => agent.createNote(requireConversation("createNote"), body),
        updateNote: (noteId, body) => agent.updateNote(requireConversation("updateNote"), noteId, body),
        deleteNote: (noteId) => agent.deleteNote(requireConversation("deleteNote"), noteId),
      });
      if (result.handled) return;

      // General message — route to the appropriate provider
      const msgProvider = commandHandler.getProviderForConversation(sessionId);
      const cwd = commandHandler.getCwdForConversation(sessionId);
      const model = commandHandler.getModelForConversation(sessionId) ?? agentCfg.model;

      agent.sendTaskUpdate(agentName, { status: "started", task: content });

      // Serialize against A2A deliveries on the same agent. agent-sdk's
      // agentWideLock already serializes WS task vs WS task; this adds the
      // missing WS task vs A2A exclusion so a fresh WS task never aborts a
      // queued A2A turn in the shared Claude process.
      const sendResult = await runExclusiveOnAgent(agentName, () =>
        runMessagePipeline({
          provider: msgProvider,
          bridgeSessionStore,
          sessionId,
          content,
          agentName,
          cwd,
          model,
          systemPrompt: agentCfg.systemPrompt,
          compactModel: agentCfg.compactModel,
          onChunk: (text) => ctx.sendChunk(text),
          signal: ctx.signal,
          uploadFile: ctx.uploadFile,
          attachments: ctx.attachments,
          conversationType: ctx.conversationType,
          senderUserId: ctx.senderUserId,
          senderUsername: ctx.senderUsername,
          members: ctx.members,
          replyTo: ctx.replyTo,
          fetchHistory: ctx.fetchHistory,
          history: ctx.history,
          senderName: ctx.senderUsername,
          userMessageMeta: { userId: ctx.senderUserId, username: ctx.senderUsername },
          reportToolCall: (report) => agent.reportToolCall(report),
          messageId: ctx.userMessageId,
        }),
      );

      if (sendResult.compacted) clearContextInjected(sessionId);

      ctx.sendComplete(sendResult.text);

      const hudUsage = msgProvider.getUsageInfo(sessionId);
      const hudSessionModel = msgProvider.getSessionInfo(sessionId)?.model ?? model ?? "";
      const hudCost = msgProvider.getCostInfo(sessionId);

      agent.sendTaskUpdate(agentName, {
        status: "completed",
        costUsd: hudCost?.totalCostUsd,
        durationMs: sendResult.durationMs,
        numTurns: sendResult.numTurns,
      });

      // Record for A2A history/watch
      recordTask({
        agent: agentName,
        content: truncate(content, 200),
        responsePreview: truncate(sendResult.text, 200),
        durationMs: sendResult.durationMs ?? 0,
        costUsd: hudCost?.totalCostUsd,
        model: hudSessionModel || undefined,
        timestamp: Date.now(),
      });

      // HUD push: fire-and-forget
      (async () => {
        const hudData: HudData = {};

        if (hudUsage?.context) {
          const total = hudUsage.context.contextWindow ?? 0;
          hudData.context = {
            used: hudUsage.context.contextTokens,
            total,
            percent: total ? Math.round((hudUsage.context.contextTokens / total) * 100) : 0,
          };
        }

        // Rate limits come from getUsageInfo() for every provider. For
        // anthropic-cli these are parsed from the PTY terminal status line;
        // other providers expose them natively.
        if (hudUsage?.rateLimits) {
          for (const rl of hudUsage.rateLimits) {
            const percent = Math.round((rl.utilization ?? 0) * 100);
            const resetIn = rl.resetsAt ? formatResetIn(rl.resetsAt) : "";
            if (rl.rateLimitType === "five_hour") hudData.limit5h = { percent, resetIn };
            if (rl.rateLimitType === "seven_day") hudData.limit7d = { percent, resetIn };
          }
        }

        hudData.model = formatModelName(hudSessionModel);
        agent.sendHud(hudData as Record<string, unknown>, conversationId);
      })().catch((err) => logger.warn(`hud-ws[${agentName}]: push failed — ${err}`));
    } catch (err) {
      const msg = getErrorMessage(err);
      if (ctx.signal.aborted || msg === "Turn aborted by user") {
        const reason = ctx.signal.aborted ? "signal aborted (client/SDK)" : `process: ${msg}`;
        logger.info(`[${agentName}] task cancelled for ${taskLabel} — ${reason}`);
        // Ensure the client receives a terminal signal so it doesn't hang.
        // The SDK's abort listener may have already sent agent_error; sendError
        // is guarded against duplicates so this is safe to call unconditionally.
        ctx.sendError("cancelled");
        return;
      }
      logger.error(`[${agentName}] task error for ${taskLabel}: ${msg}`);
      ctx.sendError(msg);
    }
  });

  agent.on("connected", () => {
    logger.info(`[${agentName}] Connected to Arinova Chat`);
  });

  agent.on("disconnected", () => {
    logger.warn(`[${agentName}] Disconnected from Arinova Chat`);
  });

  agent.on("error", (err) => {
    logger.error(`[${agentName}] Agent error: ${err.message}`);
  });

  // Onboarding claim flow: obt_* token → permanent ari_* token exchange
  const isOnboardingToken = agentCfg.botToken.startsWith("obt_");
  let claimedToken: string | null = null;

  if (isOnboardingToken) {
    agent.on("token_claimed", (data) => {
      claimedToken = data.permanentToken;
      logger.info(`[${agentName}] Onboarding token claimed — saving permanent token`);
      savePermanentToken(data.permanentToken, logger, agentName);
    });
  }

  await agent.connect();

  // Post-auth: fetch onboarding knowledge and inject into system prompt
  if (isOnboardingToken && claimedToken) {
    const agentId = agent.getAgentId();
    if (agentId) {
      const knowledge = await fetchOnboardingKnowledge(
        config.arinova.serverUrl,
        claimedToken,
        agentId,
        logger,
      );
      agentCfg.systemPrompt = agentCfg.systemPrompt
        ? `${agentCfg.systemPrompt}\n\n${knowledge}`
        : knowledge;
      logger.info(`[${agentName}] Onboarding knowledge injected (${knowledge.length} chars)`);
    }

    // Update MCP env with permanent token for sub-processes
    for (const candidateProvider of providers.values()) {
      if (candidateProvider.setAgentMcpEnv) {
        candidateProvider.setAgentMcpEnv(agentName, {
          ARINOVA_BOT_TOKEN: claimedToken,
          ARINOVA_SERVER_URL: config.arinova.serverUrl,
        });
      }
    }
  }

  activeAgents.push({ agent, name: agentName, commandHandler, provider, agentConfig: agentCfg });
  logger.info(
    `[${agentName}] started — provider=${agentCfg.provider} cwd=${agentCfg.cwd} systemPrompt=${agentCfg.systemPrompt ? `${agentCfg.systemPrompt.length} chars` : "none"}`,
  );
}

// Graceful shutdown
async function shutdown(signal: string) {
  let parentInfo = `ppid=${process.ppid}`;
  try {
    const { execSync } = await import("child_process");
    const out = execSync(`ps -p ${process.ppid} -o pid=,command=`, { timeout: 2000 }).toString().trim();
    parentInfo += `, parent=[${out}]`;
  } catch {
    parentInfo += `, parent=[not found]`;
  }
  // Capture process snapshot at signal time to find who sent it
  let processSnapshot = "";
  try {
    const { execSync } = await import("child_process");
    processSnapshot = execSync(`ps -eo pid,ppid,command | grep -E "arinova-bridge|kill|stop" | grep -v grep`, {
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    /* empty is fine */
  }

  logger.info(
    `Shutting down... (signal=${signal}, pid=${process.pid}, ${parentInfo}, uptime=${Math.round(process.uptime())}s)`,
  );
  if (processSnapshot) {
    logger.info(`Process snapshot at shutdown:\n${processSnapshot}`);
  }
  spawnManager.stopAll();
  forkManager.stopAll();
  stopIpc();
  stopRefreshTimer();

  for (const { agent, name } of activeAgents) {
    agent.disconnect();
    logger.info(`[${name}] disconnected`);
  }

  const shutdowns = Array.from(providers.values()).map((p) => p.shutdown());
  await Promise.allSettled(shutdowns);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
});

process.on("beforeExit", (code) => {
  logger.info(`beforeExit event (code=${code})`);
});
