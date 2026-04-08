import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import { loadConfig, type ResolvedAgent } from "./config.js";
import { createProviders } from "./providers/registry.js";
import { CommandHandler } from "./commands/handler.js";
import { createLogger } from "./util/logger.js";
import { startOAuthRefreshTimer } from "./oauth/refresh-timer.js";
import { HudMonitor } from "./claude/hud-monitor.js";
import { HudWebSocket, formatModelName, type HudData } from "./claude/hud-ws.js";
import { readFileSync } from "node:fs";
import { startIpcServer } from "./ipc/server.js";
import { createIpcRouter, recordTask } from "./ipc/router.js";
import type { ActiveAgent } from "./ipc/types.js";
import { BridgeSessionStore, SUMMARY_MAX_TOKENS } from "./session/bridge-session.js";
import { CronStore } from "./cron/store.js";
import { CronRunner } from "./cron/runner.js";
import { homedir } from "node:os";
import path from "node:path";

function formatResetIn(epoch: number): string {
  const epochMs = epoch < 1e12 ? epoch * 1000 : epoch;
  const diff = epochMs - Date.now();
  if (diff <= 0) return "now";
  const totalMins = Math.ceil(diff / 60_000);
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

const logger = createLogger("bridge");
const config = loadConfig();

logger.info(`Loaded config: defaultProvider=${config.defaultProvider} mcpConfigPath=${config.defaults.mcpConfigPath ?? "(none, will auto-generate)"} agents=${config.agents.length}`);

// Bridge session store — maintains conversation history across provider restarts
const bridgeSessionStore = new BridgeSessionStore(
  path.join(homedir(), ".arinova-bridge", "sessions"),
  logger,
);

// Cron scheduler
const cronStore = new CronStore(
  path.join(homedir(), ".arinova-bridge", "cron"),
  logger,
);
const cronRunner = new CronRunner(cronStore);

// Shared resources
const providers = await createProviders(config, logger);

if (providers.size === 0) {
  logger.error("No providers are enabled. Run `arinova-bridge setup` or check your config.");
  process.exit(1);
}

logger.info(`Enabled providers: ${Array.from(providers.keys()).join(", ")}`);

const stopRefreshTimer = startOAuthRefreshTimer(config.providers, logger);

// Shared HUD monitor (statusLine only needs one)
const hudMonitor = new HudMonitor({ logger });
hudMonitor.start();

const hudWsUrl = config.arinova.serverUrl + "/api/v1/hud";

// Track all agents for shutdown
const activeAgents: ActiveAgent[] = [];

// Start all agents in parallel
const startResults = await Promise.allSettled(
  config.agents.map((agentConfig) => startAgent(agentConfig)),
);
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
for (const { name, provider, agentConfig } of activeAgents) {
  const warmupId = `${name}:default`;
  provider.warmup(warmupId, {
    cwd: agentConfig.cwd,
    model: agentConfig.model,
    systemPrompt: agentConfig.systemPrompt,
  });
  logger.info(`[${name}] pre-warmed session ${warmupId}`);
}

// Start IPC server for A2A communication
const ipcRouter = createIpcRouter(activeAgents, providers, bridgeSessionStore, { cronStore, cronRunner });
const stopIpc = startIpcServer(ipcRouter, logger);

// Restore cron jobs now that agents + IPC are ready
cronRunner.setAgents(activeAgents, bridgeSessionStore);
const restoredCronJobs = cronRunner.restoreAll();
if (restoredCronJobs > 0) {
  logger.info(`Restored ${restoredCronJobs} cron job(s)`);
}


async function startAgent(agentCfg: ResolvedAgent): Promise<void> {
  const agentName = agentCfg.name;

  // Validate provider exists
  const provider = providers.get(agentCfg.provider);
  if (!provider) {
    logger.error(`agent "${agentName}": provider "${agentCfg.provider}" not found, skipping`);
    return;
  }

  // Per-agent config override for CommandHandler
  const agentBridgeConfig = {
    ...config,
    defaultProvider: agentCfg.provider,
    defaults: { ...config.defaults, cwd: agentCfg.cwd },
  };

  const commandHandler = new CommandHandler(providers, agentBridgeConfig, bridgeSessionStore);
  commandHandler.onSessionClear = (conversationId) => {
    bridgeSessionStore.clear(conversationId);
  };
  commandHandler.cronStore = cronStore;
  commandHandler.cronRunner = cronRunner;
  commandHandler.agentName = agentName;

  // Per-agent HUD WebSocket
  const hudWs = new HudWebSocket(hudWsUrl, agentCfg.botToken, logger);
  hudWs.connect();

  const agent = new ArinovaAgent({
    serverUrl: config.arinova.serverUrl,
    botToken: agentCfg.botToken,
    skills: commandHandler.getSkills(),
  });

  agent.onTask(async (ctx) => {
    const { conversationId, content } = ctx;
    // Single session per agent — Chat and A2A share the same context
    const sessionId = `${agentName}:default`;

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
      // Arinova API calls use original conversationId (not session-scoped)
      listNotes: (options) => agent.listNotes(conversationId, options),
      createNote: (body) => agent.createNote(conversationId, body),
      updateNote: (noteId, body) => agent.updateNote(conversationId, noteId, body),
      deleteNote: (noteId) => agent.deleteNote(conversationId, noteId),
    });
    if (result.handled) return;

    // General message — route to the appropriate provider
    try {
      const msgProvider = commandHandler.getProviderForConversation(sessionId);
      const cwd = commandHandler.getCwdForConversation(sessionId);
      const model = commandHandler.getModelForConversation(sessionId) ?? agentCfg.model;

      hudWs.sendTask(agentName, { status: "started", task: content });

      // Build context from bridge session BEFORE adding current message
      // (so the current message isn't duplicated in the history prefix)
      const bridgeSessionContext = bridgeSessionStore.buildContext(sessionId) || undefined;

      // Record user message in bridge session
      bridgeSessionStore.addUserMessage(sessionId, content, ctx.senderUsername, {
        model,
        userId: ctx.senderUserId,
        username: ctx.senderUsername,
      });

      const sendResult = await msgProvider.sendMessage({
        conversationId: sessionId,
        content,
        cwd,
        model,
        systemPrompt: agentCfg.systemPrompt,
        onChunk: (text) => ctx.sendChunk(text),
        signal: ctx.signal,
        uploadFile: ctx.uploadFile,
        attachments: ctx.attachments,
        conversationType: ctx.conversationType,
        senderUserId: ctx.senderUserId,
        senderUsername: ctx.senderUsername,
        members: ctx.members,
        replyTo: ctx.replyTo,
        bridgeSessionContext,
        fetchHistory: ctx.fetchHistory,
      });

      // Record assistant response in bridge session
      bridgeSessionStore.addAssistantMessage(sessionId, sendResult.text, agentName, { model });

      // Auto-compact if context exceeds 80% of model's window
      if (bridgeSessionStore.needsCompact(sessionId, model)) {
        logger.info(`[${agentName}] context threshold reached for ${sessionId}, compacting...`);
        await bridgeSessionStore.compact(sessionId, async (messages, existingSummary) => {
          // Use the same provider to generate a summary
          let summary = "";
          const tokenBudget = `請控制在 ${SUMMARY_MAX_TOKENS} tokens 以內。`;
          const summaryPrompt = existingSummary
            ? `以下是先前的對話摘要和後續的對話紀錄。請將它們合併成一份簡潔的摘要，保留關鍵決策、任務狀態和重要上下文。${tokenBudget}\n\n先前摘要:\n${existingSummary}\n\n後續對話:\n${messages.map((m) => `${m.sender ?? m.role}: ${m.content}`).join("\n")}`
            : `請將以下對話紀錄摘要成簡潔的重點，保留關鍵決策、任務狀態和重要上下文。${tokenBudget}\n\n${messages.map((m) => `${m.sender ?? m.role}: ${m.content}`).join("\n")}`;

          const compactResult = await msgProvider.sendMessage({
            conversationId: `${sessionId}:compact`,
            content: summaryPrompt,
            cwd,
            model,
            onChunk: (text) => { summary = text; },
            systemPrompt: "You are a conversation summariser. Output only the summary, nothing else. Write in the same language as the conversation.",
          });
          return compactResult.text;
        });
      }

      ctx.sendComplete(sendResult.text);

      const hudUsage = msgProvider.getUsageInfo(sessionId);
      const hudSessionModel = msgProvider.getSessionInfo(sessionId)?.model ?? model ?? "";
      const hudCost = msgProvider.getCostInfo(sessionId);

      hudWs.sendTask(agentName, {
        status: "completed",
        costUsd: hudCost?.totalCostUsd,
        durationMs: sendResult.durationMs,
        numTurns: sendResult.numTurns,
      });

      // Record for A2A history/watch
      recordTask({
        agent: agentName,
        content: content.length > 200 ? content.slice(0, 200) + "…" : content,
        responsePreview: sendResult.text.length > 200 ? sendResult.text.slice(0, 200) + "…" : sendResult.text,
        durationMs: sendResult.durationMs ?? 0,
        costUsd: hudCost?.totalCostUsd,
        model: hudSessionModel || undefined,
        timestamp: Date.now(),
      });

      // HUD push: fire-and-forget
      (async () => {
        await hudMonitor.notify();
        const hudData: HudData = {};

        if (hudUsage?.context) {
          const total = hudUsage.context.contextWindow ?? 0;
          hudData.context = {
            used: hudUsage.context.contextTokens,
            total,
            percent: total ? Math.round((hudUsage.context.contextTokens / total) * 100) : 0,
          };
        }

        // Rate limits: Claude reads status file; other providers use rateLimits from getUsageInfo()
        if (msgProvider.type.startsWith("anthropic")) {
          try {
            const sf = JSON.parse(readFileSync("/tmp/claude-status.json", "utf-8")) as Record<string, unknown>;
            if (sf.limit5h) hudData.limit5h = sf.limit5h as HudData["limit5h"];
            if (sf.limit7d) hudData.limit7d = sf.limit7d as HudData["limit7d"];
          } catch { /* status file unavailable */ }
        } else if (hudUsage?.rateLimits) {
          for (const rl of hudUsage.rateLimits) {
            const percent = Math.round((rl.utilization ?? 0) * 100);
            const resetIn = rl.resetsAt ? formatResetIn(rl.resetsAt) : "";
            if (rl.rateLimitType === "five_hour") hudData.limit5h = { percent, resetIn };
            if (rl.rateLimitType === "seven_day") hudData.limit7d = { percent, resetIn };
          }
        }

        hudData.model = formatModelName(hudSessionModel);
        hudWs.send(conversationId, hudData);
      })().catch((err) => logger.warn(`hud-ws[${agentName}]: push failed — ${err}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.signal.aborted || msg === "Turn aborted by user") {
        const reason = ctx.signal.aborted ? "signal aborted (client/SDK)" : `process: ${msg}`;
        logger.info(`[${agentName}] task cancelled for ${conversationId} — ${reason}`);
        // Ensure the client receives a terminal signal so it doesn't hang.
        // The SDK's abort listener may have already sent agent_error; sendError
        // is guarded against duplicates so this is safe to call unconditionally.
        ctx.sendError("cancelled");
        return;
      }
      logger.error(`[${agentName}] task error for ${conversationId}: ${msg}`);
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

  await agent.connect();
  activeAgents.push({ agent, name: agentName, hudWs, commandHandler, provider, agentConfig: agentCfg });
  logger.info(`[${agentName}] started — provider=${agentCfg.provider} cwd=${agentCfg.cwd} systemPrompt=${agentCfg.systemPrompt ? `${agentCfg.systemPrompt.length} chars` : "none"}`);
}

// Graceful shutdown
async function shutdown() {
  logger.info("Shutting down...");
  cronRunner.stopAll();
  stopIpc();
  hudMonitor.stop();
  stopRefreshTimer();

  for (const { agent, hudWs, name } of activeAgents) {
    hudWs.close();
    agent.disconnect();
    logger.info(`[${name}] disconnected`);
  }

  const shutdowns = Array.from(providers.values()).map((p) => p.shutdown());
  await Promise.allSettled(shutdowns);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
