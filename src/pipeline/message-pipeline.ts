import type { Provider, SendMessageOpts, SendResult, ToolCallReport } from "../providers/types.js";
import { type BridgeSessionStore, getSummaryMaxTokens, buildCompactPrompt } from "../session/bridge-session.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("pipeline");

/**
 * Turn-level errors that leave the provider session in a stuck state
 * (image payload over dimension limit, context window overflow). Recovery
 * path is resetSession + single retry — see Step 4 below.
 */
const UNRECOVERABLE_TURN_ERROR_PATTERNS = [
  "exceeds the dimension limit",
  "prompt is too long",
  "context_length_exceeded",
] as const;

function isUnrecoverableTurnError(msg: string): boolean {
  return UNRECOVERABLE_TURN_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

// ---------------------------------------------------------------------------
// Context-injection tracking (shared across Chat + A2A)
// ---------------------------------------------------------------------------

/** Sessions that have already received bridge context injection. */
const contextInjected = new Set<string>();
/** Provider-side session IDs to detect mid-turn respawns. */
const lastProviderSessionId = new Map<string, string>();

/** Clear context-injection tracking for a session (e.g. after /model, /compact, /new). */
export function clearContextInjected(sessionId: string): void {
  contextInjected.delete(sessionId);
  lastProviderSessionId.delete(sessionId);
}

// ---------------------------------------------------------------------------
// PipelineContext — caller-provided differences between Chat and A2A paths
// ---------------------------------------------------------------------------

export interface PipelineContext {
  /** The provider to send to. */
  provider: Provider;
  /** Bridge session store for context building / recording / compacting. */
  bridgeSessionStore: BridgeSessionStore;
  /** Conversation/session ID (e.g. "agentName:default"). */
  sessionId: string;
  /** The user message content. */
  content: string;
  /** Agent name (for logging + assistant message recording). */
  agentName: string;
  /** Working directory for the provider. */
  cwd: string;
  /** Model override. */
  model?: string;
  /** Agent system prompt. */
  systemPrompt?: string;
  /** Compact model override (falls back to model). */
  compactModel?: string;

  // --- Callbacks ---
  /** Streaming chunk callback. */
  onChunk: (text: string) => void;
  /** Abort signal. */
  signal?: AbortSignal;
  // --- Optional Chat-specific fields (passed through to sendMessage) ---
  uploadFile?: SendMessageOpts["uploadFile"];
  attachments?: SendMessageOpts["attachments"];
  conversationType?: string;
  senderUserId?: string;
  senderUsername?: string;
  members?: SendMessageOpts["members"];
  replyTo?: SendMessageOpts["replyTo"];
  fetchHistory?: SendMessageOpts["fetchHistory"];
  /** Backend-provided conversation history; when present, skips bridge's own history. */
  history?: SendMessageOpts["history"];

  // --- Optional A2A-specific fields ---
  /** When true, queue behind any in-flight turn instead of aborting. */
  queue?: boolean;
  /** Extra context to prepend (e.g. A2A memory query results). */
  extraContext?: string;

  // --- Message recording metadata ---
  /** Sender name for addUserMessage (username or agent name). */
  senderName?: string;
  /** Extra metadata for addUserMessage. */
  userMessageMeta?: Record<string, unknown>;

  /**
   * Per-tool-call reporter forwarded to the provider so each tool result
   * gets pushed to the Arinova server's tool_call_logs table. Wired by the
   * caller to `agent.reportToolCall(report)`.
   */
  reportToolCall?: (report: ToolCallReport) => void | Promise<void>;
  /** UUID of the user message that triggered this send (forwarded to tool call reports). */
  messageId?: string;
}

export interface PipelineResult {
  /** Final assistant response text. */
  text: string;
  /** Provider session ID (if available). */
  sessionId?: string;
  /** Duration in ms (from provider). */
  durationMs?: number;
  /** Number of turns (from provider). */
  numTurns?: number;
  /** Whether auto-compact was triggered. */
  compacted: boolean;
}

// ---------------------------------------------------------------------------
// runMessagePipeline — the unified 8-step flow
// ---------------------------------------------------------------------------

export async function runMessagePipeline(ctx: PipelineContext): Promise<PipelineResult> {
  const {
    provider,
    bridgeSessionStore,
    sessionId,
    content,
    agentName,
    cwd,
    model,
    compactModel: compactModelOverride,
  } = ctx;

  // Step 1: Detect provider session death or respawn → force re-injection
  const sessionInfo = provider.getSessionInfo(sessionId);
  const prevSid = lastProviderSessionId.get(sessionId);
  if (prevSid && (!sessionInfo || !sessionInfo.alive)) {
    clearContextInjected(sessionId);
  }
  if (sessionInfo && prevSid && sessionInfo.sessionId !== prevSid) {
    clearContextInjected(sessionId);
  }

  // Step 2: Build bootstrap context only on first message of a new/reset provider session.
  // Persistent provider sessions/threads already retain their own history. On bootstrap,
  // prefer BridgeSessionStore because it can include compacted long-term context; fall
  // back to backend recent history only when the bridge has no context yet.
  const isFirstMessage = !contextInjected.has(sessionId);
  let injectedContextThisTurn = isFirstMessage;
  let bridgeSessionContext = isFirstMessage
    ? (bridgeSessionStore.buildContext(sessionId) || undefined)
    : undefined;
  const historyForProvider = isFirstMessage && !bridgeSessionContext ? ctx.history : undefined;

  // Prepend extra context (e.g. A2A memory query results) if provided
  if (isFirstMessage && ctx.extraContext) {
    bridgeSessionContext = bridgeSessionContext
      ? `${ctx.extraContext}\n\n${bridgeSessionContext}`
      : ctx.extraContext;
  }

  // Step 3: Record user message in bridge session
  bridgeSessionStore.addUserMessage(
    sessionId,
    content,
    ctx.senderName,
    { model, ...ctx.userMessageMeta },
  );

  // Step 4: Send message to provider (auto-restart on unrecoverable turn errors)
  const sendMessageArgs: SendMessageOpts = {
    conversationId: sessionId,
    content,
    cwd,
    model,
    systemPrompt: ctx.systemPrompt,
    onChunk: ctx.onChunk,
    signal: ctx.signal,
    uploadFile: ctx.uploadFile,
    attachments: ctx.attachments,
    conversationType: ctx.conversationType,
    senderUserId: ctx.senderUserId,
    senderUsername: ctx.senderUsername,
    members: ctx.members,
    replyTo: ctx.replyTo,
    fetchHistory: ctx.fetchHistory,
    history: historyForProvider,
    bridgeSessionContext,
    queue: ctx.queue,
    reportToolCall: ctx.reportToolCall,
    messageId: ctx.messageId,
  };

  let sendResult: SendResult;
  try {
    sendResult = await provider.sendMessage(sendMessageArgs);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!isUnrecoverableTurnError(errMsg)) throw err;

    const matchedPattern = UNRECOVERABLE_TURN_ERROR_PATTERNS.find((p) => errMsg.includes(p));
    log.warn(
      `[${agentName}] unrecoverable turn error for ${sessionId} at ${new Date().toISOString()}: pattern="${matchedPattern}" msg="${errMsg}" — resetting session and retrying once`,
    );

    await provider.resetSession(sessionId, { cwd, model });
    clearContextInjected(sessionId);

    // Provider session was destroyed — rebuild context for the fresh session.
    let retryContext = bridgeSessionStore.buildContext(sessionId) || undefined;
    const retryHistory = retryContext ? undefined : ctx.history;
    if (ctx.extraContext) {
      retryContext = retryContext ? `${ctx.extraContext}\n\n${retryContext}` : ctx.extraContext;
    }

    sendResult = await provider.sendMessage({
      ...sendMessageArgs,
      bridgeSessionContext: retryContext,
      history: retryHistory,
    });
    injectedContextThisTurn = true;
  }

  // Step 5: Mark session as context-injected + track provider session ID
  if (injectedContextThisTurn) contextInjected.add(sessionId);
  if (sendResult.sessionId) {
    lastProviderSessionId.set(sessionId, sendResult.sessionId);
  }

  // Step 6: Record assistant response in bridge session
  bridgeSessionStore.addAssistantMessage(sessionId, sendResult.text, agentName, { model });

  // Step 7: Auto-compact if context exceeds threshold
  let compacted = false;
  const runtimeContextWindow = provider.getUsageInfo(sessionId)?.context?.contextWindow;
  if (bridgeSessionStore.needsCompact(sessionId, model, runtimeContextWindow)) {
    const compactModel = compactModelOverride ?? model;
    const windowSource = runtimeContextWindow ? `reported window ${runtimeContextWindow}` : "fallback model window";
    log.info(`[${agentName}] context threshold reached for ${sessionId} (${windowSource}), compacting with ${compactModel}...`);
    try {
      await bridgeSessionStore.compact(sessionId, async (messages, existingSummary) => {
        const tokenBudget = getSummaryMaxTokens(compactModel);
        const conversationText = messages
          .map((m) => `${m.sender ?? m.role}: ${m.role === "user" ? (m.userMessage?.trim() || m.content) : m.content}`)
          .join("\n");
        const summaryPrompt = buildCompactPrompt(conversationText, tokenBudget, existingSummary);
        const compactConversationId = `${sessionId}:compact`;

        await provider.resetSession(compactConversationId, { cwd, model: compactModel });
        const compactResult = await provider.sendMessage({
          conversationId: compactConversationId,
          content: summaryPrompt,
          cwd,
          model: compactModel,
          onChunk: () => {},
          systemPrompt: "You are a conversation summariser. Output only the summary, nothing else. Write in the same language as the conversation.",
        });
        return compactResult.text;
      }, { model: compactModel });

      // Step 8: Reset provider session so it starts fresh with compacted context
      await provider.resetSession(sessionId, { cwd, model });
      clearContextInjected(sessionId);
      compacted = true;
    } catch (err) {
      log.warn(`[${agentName}] auto-compact failed for ${sessionId}: ${err}`);
    }
  }

  return {
    text: sendResult.text,
    sessionId: sendResult.sessionId,
    durationMs: sendResult.durationMs,
    numTurns: sendResult.numTurns,
    compacted,
  };
}
