import type { Provider, SendMessageOpts, SendResult, ToolCallReport } from "../providers/types.js";
import { type BridgeSessionStore, getSummaryMaxTokens, buildCompactPrompt } from "../session/bridge-session.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("pipeline");

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
  /** Fire-and-forget reporter for completed tool calls (Claude providers only). */
  reportToolCall?: SendMessageOpts["reportToolCall"];

  // --- Optional Chat-specific fields (passed through to sendMessage) ---
  uploadFile?: SendMessageOpts["uploadFile"];
  attachments?: SendMessageOpts["attachments"];
  conversationType?: string;
  senderUserId?: string;
  senderUsername?: string;
  members?: SendMessageOpts["members"];
  replyTo?: SendMessageOpts["replyTo"];
  fetchHistory?: SendMessageOpts["fetchHistory"];

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

  // Step 2: Build bridge session context (only on first message of a new/reset session)
  const isFirstMessage = !contextInjected.has(sessionId);
  let bridgeSessionContext = isFirstMessage
    ? (bridgeSessionStore.buildContext(sessionId) || undefined)
    : undefined;

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

  // Step 4: Send message to provider
  const sendResult: SendResult = await provider.sendMessage({
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
    bridgeSessionContext,
    queue: ctx.queue,
    reportToolCall: ctx.reportToolCall,
  });

  // Step 5: Mark session as context-injected + track provider session ID
  if (isFirstMessage) contextInjected.add(sessionId);
  if (sendResult.sessionId) {
    lastProviderSessionId.set(sessionId, sendResult.sessionId);
  }

  // Step 6: Record assistant response in bridge session
  bridgeSessionStore.addAssistantMessage(sessionId, sendResult.text, agentName, { model });

  // Step 7: Auto-compact if context exceeds threshold
  let compacted = false;
  if (bridgeSessionStore.needsCompact(sessionId, model)) {
    const compactModel = compactModelOverride ?? model;
    log.info(`[${agentName}] context threshold reached for ${sessionId}, compacting with ${compactModel}...`);
    try {
      await bridgeSessionStore.compact(sessionId, async (messages, existingSummary) => {
        const tokenBudget = getSummaryMaxTokens(compactModel);
        const conversationText = messages.map((m) => `${m.sender ?? m.role}: ${m.content}`).join("\n");
        const summaryPrompt = buildCompactPrompt(conversationText, tokenBudget, existingSummary);

        const compactResult = await provider.sendMessage({
          conversationId: `${sessionId}:compact`,
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
