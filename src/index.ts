import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import { loadConfig, type ResolvedAgent } from "./config.js";
import { createProviders } from "./providers/registry.js";
import { CommandHandler } from "./commands/handler.js";
import { createLogger } from "./util/logger.js";
import { startOAuthRefreshTimer } from "./oauth/refresh-timer.js";
import { HudMonitor } from "./claude/hud-monitor.js";
import { HudWebSocket, formatModelName, type HudData } from "./claude/hud-ws.js";
import { readFileSync } from "node:fs";

const logger = createLogger("bridge");
const config = loadConfig();

logger.info(`Loaded config: defaultProvider=${config.defaultProvider} mcpConfigPath=${config.defaults.mcpConfigPath ?? "(none, will auto-generate)"} agents=${config.agents.length}`);

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
const activeAgents: Array<{ agent: ArinovaAgent; name: string; hudWs: HudWebSocket }> = [];

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

  const commandHandler = new CommandHandler(providers, agentBridgeConfig);

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
    // Prefix conversationId with agent name to isolate sessions across agents
    const sessionId = `${agentName}:${conversationId}`;

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

      hudWs.sendTask(agentName, { status: "started", task: content.slice(0, 200) });

      const sendResult = await msgProvider.sendMessage({
        conversationId: sessionId,
        content,
        cwd,
        model,
        onChunk: (text) => ctx.sendChunk(text),
        signal: ctx.signal,
        uploadFile: ctx.uploadFile,
        attachments: ctx.attachments,
        conversationType: ctx.conversationType,
        senderUserId: ctx.senderUserId,
        senderUsername: ctx.senderUsername,
        members: ctx.members,
        replyTo: ctx.replyTo,
        history: ctx.history,
        fetchHistory: ctx.fetchHistory,
      });

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

        try {
          const sf = JSON.parse(readFileSync("/tmp/claude-status.json", "utf-8")) as Record<string, unknown>;
          if (sf.limit5h) hudData.limit5h = sf.limit5h as HudData["limit5h"];
          if (sf.limit7d) hudData.limit7d = sf.limit7d as HudData["limit7d"];
        } catch { /* status file unavailable */ }

        hudData.model = formatModelName(hudSessionModel);
        hudWs.send(conversationId, hudData);
      })().catch((err) => logger.warn(`hud-ws[${agentName}]: push failed — ${err}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.signal.aborted || msg === "Turn aborted by user") {
        logger.info(`[${agentName}] task cancelled for ${conversationId}`);
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
  activeAgents.push({ agent, name: agentName, hudWs });
  logger.info(`[${agentName}] started — provider=${agentCfg.provider} cwd=${agentCfg.cwd}`);
}

// Graceful shutdown
async function shutdown() {
  logger.info("Shutting down...");
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
