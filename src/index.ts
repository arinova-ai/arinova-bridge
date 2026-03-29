import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/registry.js";
import { CommandHandler } from "./commands/handler.js";
import { createLogger } from "./util/logger.js";
import { startOAuthRefreshTimer } from "./oauth/refresh-timer.js";
import { HudMonitor } from "./claude/hud-monitor.js";
import { HudWebSocket, formatModelName, type HudData } from "./claude/hud-ws.js";
import { readFileSync } from "node:fs";

const logger = createLogger("bridge");
const config = loadConfig();

logger.info(`Loaded config: defaultProvider=${config.defaultProvider} mcpConfigPath=${config.defaults.mcpConfigPath ?? "(none, will auto-generate)"}`);

const providers = await createProviders(config, logger);

if (providers.size === 0) {
  logger.error("No providers are enabled. Run `arinova-bridge setup` or check your config.");
  process.exit(1);
}

logger.info(`Enabled providers: ${Array.from(providers.keys()).join(", ")}`);

const commandHandler = new CommandHandler(providers, config);

// Start background OAuth token refresh
const stopRefreshTimer = startOAuthRefreshTimer(config.providers, logger);

// Start HUD monitor for statusLine-based rate limit tracking
const hudMonitor = new HudMonitor({ logger });
hudMonitor.start();

// Start HUD WebSocket for pushing context/rate-limit data to arinova-chat
const hudWsUrl = config.arinova.serverUrl + "/api/v1/hud";
const hudWs = new HudWebSocket(hudWsUrl, config.arinova.botToken, logger);
hudWs.connect();

const agent = new ArinovaAgent({
  serverUrl: config.arinova.serverUrl,
  botToken: config.arinova.botToken,
  skills: commandHandler.getSkills(),
});

agent.onTask(async (ctx) => {
  const { conversationId, content } = ctx;

  // Try command handling first
  const result = await commandHandler.handle(content, {
    conversationId,
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
    listNotes: (options) => agent.listNotes(conversationId, options),
    createNote: (body) => agent.createNote(conversationId, body),
    updateNote: (noteId, body) => agent.updateNote(conversationId, noteId, body),
    deleteNote: (noteId) => agent.deleteNote(conversationId, noteId),
  });
  if (result.handled) return;

  // General message — route to the appropriate provider
  try {
    const provider = commandHandler.getProviderForConversation(conversationId);
    const cwd = commandHandler.getCwdForConversation(conversationId);
    const model = commandHandler.getModelForConversation(conversationId);

    // Push task started
    hudWs.sendTask(config.arinova.agentName, { status: "started", task: content.slice(0, 200) });

    const sendResult = await provider.sendMessage({
      conversationId,
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

    // Snapshot context, model, cost before async work
    const hudUsage = provider.getUsageInfo(conversationId);
    const hudSessionModel = provider.getSessionInfo(conversationId)?.model ?? model ?? "";
    const hudCost = provider.getCostInfo(conversationId);

    // Push task completed
    hudWs.sendTask(config.arinova.agentName, {
      status: "completed",
      costUsd: hudCost?.totalCostUsd,
      durationMs: sendResult.durationMs,
      numTurns: sendResult.numTurns,
    });

    // HUD push: fire-and-forget (don't block next message)
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
    })().catch((err) => logger.warn(`hud-ws: push failed — ${err}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // User-initiated cancel (via SDK signal) or superseded by a new message
    if (ctx.signal.aborted || msg === "Turn aborted by user") {
      logger.info(`task cancelled for ${conversationId}`);
      return;
    }
    logger.error(`task error for ${conversationId}: ${msg}`);
    ctx.sendError(msg);
  }
});

agent.on("connected", () => {
  logger.info("Connected to Arinova Chat");
});

agent.on("disconnected", () => {
  logger.warn("Disconnected from Arinova Chat");
});

agent.on("error", (err) => {
  logger.error(`Agent error: ${err.message}`);
});

// Graceful shutdown
async function shutdown() {
  logger.info("Shutting down...");
  hudWs.close();
  hudMonitor.stop();
  stopRefreshTimer();
  const shutdowns = Array.from(providers.values()).map((p) => p.shutdown());
  await Promise.allSettled(shutdowns);
  agent.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
agent.connect().then(() => {
  logger.info(
    `Bridge started — server=${config.arinova.serverUrl} ` +
    `defaultProvider=${config.defaultProvider} ` +
    `providers=[${Array.from(providers.keys()).join(",")}]`,
  );
}).catch((err) => {
  logger.error(`Failed to connect: ${err.message}`);
  process.exit(1);
});
