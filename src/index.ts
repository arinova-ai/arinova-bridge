import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/registry.js";
import { CommandHandler } from "./commands/handler.js";
import { createLogger } from "./util/logger.js";
import { startOAuthRefreshTimer } from "./oauth/refresh-timer.js";

const logger = createLogger("bridge");
const config = loadConfig();

logger.info(`Loaded config: defaultProvider=${config.defaultProvider}`);

const providers = await createProviders(config, logger);

if (providers.size === 0) {
  logger.error("No providers are enabled. Run `arinova-bridge setup` or check your config.");
  process.exit(1);
}

logger.info(`Enabled providers: ${Array.from(providers.keys()).join(", ")}`);

const commandHandler = new CommandHandler(providers, config);

// Start background OAuth token refresh
const stopRefreshTimer = startOAuthRefreshTimer(config.providers, logger);

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
  });
  if (result.handled) return;

  // General message — route to the appropriate provider
  try {
    const provider = commandHandler.getProviderForConversation(conversationId);
    const cwd = commandHandler.getCwdForConversation(conversationId);
    const model = commandHandler.getModelForConversation(conversationId);

    let accumulated = "";
    const sendResult = await provider.sendMessage({
      conversationId,
      content,
      cwd,
      model,
      onChunk: (text) => {
        accumulated += text;
        ctx.sendChunk(accumulated);
      },
    });

    ctx.sendComplete(sendResult.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
