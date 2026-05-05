import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Provider } from "../providers/types.js";
import type { BridgeConfig } from "../config.js";
import type { CommandContext, CommandResult } from "./types.js";
import { type BridgeSessionStore, getSummaryMaxTokens, buildCompactPrompt } from "../session/bridge-session.js";
import type { SpawnManager } from "../spawn/manager.js";
import type { ForkManager } from "../fork/manager.js";
export class CommandHandler {
  private providers: Map<string, Provider>;
  private config: BridgeConfig;
  private sessionStore?: BridgeSessionStore;

  /** Per-conversation provider overrides (set by /provider). */
  private providerOverrides = new Map<string, string>();
  /** Per-conversation cwd overrides (set by /new). */
  private cwdOverrides = new Map<string, string>();
  /** Per-conversation model overrides (set by /model). */
  private modelOverrides = new Map<string, string>();

  /** Called when a session is fully cleared (/new) — clears DB + tracking flags. */
  onSessionClear?: (conversationId: string) => void;
  /** Called when a session is reset (/model, /compact) — clears tracking flags only, preserves DB. */
  onSessionReset?: (conversationId: string) => void;

  /** Spawn manager (injected after startup). */
  spawnManager?: SpawnManager;
  /** Fork manager (injected after startup). */
  forkManager?: ForkManager;
  /** Agent name this handler belongs to (for spawn/fork ownership). */
  agentName?: string;

  constructor(providers: Map<string, Provider>, config: BridgeConfig, sessionStore?: BridgeSessionStore) {
    this.providers = providers;
    this.config = config;
    this.sessionStore = sessionStore;
  }

  /** Get the effective provider for a conversation. */
  getProviderForConversation(conversationId: string): Provider {
    const overrideId = this.providerOverrides.get(conversationId);
    if (overrideId) {
      const provider = this.providers.get(overrideId);
      if (provider) return provider;
    }
    const defaultProvider = this.providers.get(this.config.defaultProvider);
    if (defaultProvider) return defaultProvider;
    // Fallback to first available
    const first = this.providers.values().next();
    if (first.done) throw new Error("No providers are enabled");
    return first.value;
  }

  getCwdForConversation(conversationId: string): string {
    return this.cwdOverrides.get(conversationId) ?? this.config.defaults.cwd;
  }

  getModelForConversation(conversationId: string): string | undefined {
    return this.modelOverrides.get(conversationId);
  }

  async handle(content: string, ctx: CommandContext): Promise<CommandResult> {
    const trimmed = content.trim();
    if (!trimmed.startsWith("/")) return { handled: false };

    const spaceIdx = trimmed.indexOf(" ");
    const cmd = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "new":
        await this.handleNew(arg, ctx);
        return { handled: true };
      case "sessions":
        this.handleSessions(ctx);
        return { handled: true };
      case "status":
        this.handleStatus(ctx);
        return { handled: true };
      case "help":
        this.handleHelp(ctx);
        return { handled: true };
      case "stop":
        this.handleStop(ctx);
        return { handled: true };
      case "resume":
        await this.handleResume(arg, ctx);
        return { handled: true };
      case "model":
        await this.handleModel(arg, ctx);
        return { handled: true };
      case "compact":
        await this.handleCompact(ctx);
        return { handled: true };
      case "cost":
        this.handleCost(ctx);
        return { handled: true };
      case "hud-for-usage":
        this.handleUsage(ctx);
        return { handled: true };
      case "search":
        this.handleSearch(arg, ctx);
        return { handled: true };
      case "provider":
        await this.handleProvider(arg, ctx);
        return { handled: true };
      case "notes":
        await this.handleNotes(arg, ctx);
        return { handled: true };
      case "note-add":
        await this.handleNoteAdd(arg, ctx);
        return { handled: true };
      case "note-edit":
        await this.handleNoteEdit(arg, ctx);
        return { handled: true };
      case "note-del":
        await this.handleNoteDel(arg, ctx);
        return { handled: true };
      case "spawn":
        this.handleSpawn(arg, ctx);
        return { handled: true };
      case "fork":
        this.handleFork(arg, ctx);
        return { handled: true };
      default:
        return { handled: false };
    }
  }

  /** Get all configured (enabled) provider IDs from config, not just successfully created ones. */
  private getConfiguredProviderIds(): string[] {
    return this.config.providers
      .filter((p) => p.enabled)
      .map((p) => p.id);
  }

  /** Check if any configured provider has a type starting with the given prefix. */
  private hasProviderType(prefix: string): boolean {
    return this.config.providers.some((p) => p.enabled && p.type.startsWith(prefix));
  }

  /** Get the list of skills to register with Arinova. */
  getSkills(): Array<{ id: string; name: string; description: string }> {
    const ids = this.getConfiguredProviderIds().join(" / ");
    const skills = [
      { id: "new", name: "New", description: "開新工作階段 (可帶路徑: /new ~/project)" },
      { id: "sessions", name: "Sessions", description: "列出所有 sessions" },
      { id: "status", name: "Status", description: "查看目前 session 狀態" },
      { id: "stop", name: "Stop", description: "中斷目前正在執行的操作" },
      { id: "resume", name: "Resume", description: "恢復指定的 session (/resume <session-id>)" },
      { id: "model", name: "Model", description: "切換模型" },
      { id: "compact", name: "Compact", description: "壓縮對話 context (僅 Anthropic)" },
      { id: "search", name: "Search", description: "搜尋歷史對話 (/search <關鍵字>)" },
      { id: "provider", name: "Provider", description: `切換 provider (${ids})` },
      { id: "spawn", name: "Spawn", description: "子 Agent 任務派發 (/spawn list|cancel)" },
      { id: "fork", name: "Fork", description: "Fork 分身執行任務 (/fork <task>|list|cancel)" },
    ];

    return skills;
  }

  // --- Command Handlers ---

  private reply(ctx: CommandContext, text: string): void {
    ctx.sendChunk(text);
    ctx.sendComplete(text);
  }

  private async handleNew(arg: string, ctx: CommandContext): Promise<void> {
    const provider = this.getProviderForConversation(ctx.conversationId);

    if (arg) {
      const resolved = resolve(arg.replace(/^~/, homedir()));
      if (!existsSync(resolved)) {
        this.reply(ctx, `路徑不存在: ${resolved}`);
        return;
      }
      this.cwdOverrides.set(ctx.conversationId, resolved);
    } else {
      this.cwdOverrides.delete(ctx.conversationId);
    }

    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    await provider.resetSession(ctx.conversationId, { cwd, model });
    this.onSessionClear?.(ctx.conversationId);

    this.reply(
      ctx,
      `已開啟新的工作階段\n工作目錄: ${cwd}${model ? `\n模型: ${model}` : ""}\nProvider: ${provider.displayName}`,
    );
  }

  private handleSessions(ctx: CommandContext): void {
    const activeProvider = this.getProviderForConversation(ctx.conversationId);
    const activeSession = activeProvider.getSessionInfo(ctx.conversationId);

    const allSessions: Array<{
      providerId: string;
      sessionId: string;
      conversationId: string;
      status: string;
      cwd: string;
      model?: string;
    }> = [];

    for (const provider of this.providers.values()) {
      for (const s of provider.listSessions()) {
        allSessions.push(s);
      }
    }

    if (allSessions.length === 0) {
      this.reply(ctx, "目前沒有任何 session");
      return;
    }

    const lines = ["Sessions:\n"];
    for (const s of allSessions) {
      const isCurrent = s.providerId === activeProvider.id
        && s.conversationId === ctx.conversationId
        && !!activeSession
        && s.sessionId === activeSession.sessionId;
      const dot = isCurrent ? "🟢" : "⚪";
      const id = s.sessionId.slice(0, 12);
      const model = s.model ?? "default";
      lines.push(`${dot} [${s.providerId}] ${id}  ${s.status}  ${model}  ${s.cwd}`);
    }
    lines.push("\n用法: /resume <session-id>");
    this.reply(ctx, lines.join("\n"));
  }

  private handleStatus(ctx: CommandContext): void {
    const provider = this.getProviderForConversation(ctx.conversationId);
    const info = provider.getSessionInfo(ctx.conversationId);

    if (!info) {
      this.reply(ctx, "目前無活躍的 session\n發送任何訊息即可自動建立");
      return;
    }

    const lines = [
      `Provider: ${provider.displayName}`,
      `狀態: ${info.alive ? "連線中" : "已停止"}`,
      `工作目錄: ${info.cwd}`,
      `Session ID: ${info.sessionId.slice(0, 12) || "N/A"}`,
      `模型: ${info.model ?? "default"}`,
    ];

    const cost = provider.getCostInfo(ctx.conversationId);
    if (cost) {
      if (cost.totalCostUsd !== undefined) {
        lines.push(`累計花費: $${cost.totalCostUsd.toFixed(4)}`);
      }
      if (cost.inputTokens !== undefined) {
        lines.push(`Tokens: in=${cost.inputTokens} (cached=${cost.cachedInputTokens ?? 0}), out=${cost.outputTokens ?? 0}`);
      }
    }

    this.reply(ctx, lines.join("\n"));
  }

  private handleHelp(ctx: CommandContext): void {
    const provider = this.getProviderForConversation(ctx.conversationId);
    const lines = [
      `可用指令 (目前 Provider: ${provider.displayName}):\n`,
      "/new [path] — 開新工作階段 (可帶路徑)",
      "/sessions — 列出所有 sessions",
      "/status — 查看目前 session 狀態",
      "/stop — 中斷目前正在執行的操作",
      "/resume <session-id> — 恢復指定的 session",
      "/model [name] — 切換模型",
      "/cost — 顯示累計花費 / token 用量",
      "/hud-for-usage — 顯示 context 用量與 rate limit 狀態",
    ];

    if (this.hasProviderType("anthropic")) {
      lines.push("/compact — 壓縮對話上下文 (Anthropic only)");
    }

    lines.push(
      "/search <關鍵字> — 搜尋歷史對話",
      "/notes — 列出對話筆記",
      "/note-add <標題> | <內容> — 新增筆記",
      "/note-edit <id> <標題> | <內容> — 編輯筆記",
      "/note-del <id> — 刪除筆記",
    );

    const ids = this.getConfiguredProviderIds().join(" / ");
    lines.push(`/provider [name] — 切換 provider (${ids})`);

    lines.push(
      "/spawn list — 列出 spawn 子任務",
      "/spawn cancel <id> — 取消 spawn 子任務",
    );

    lines.push("/help — 列出所有可用指令");
    this.reply(ctx, lines.join("\n"));
  }

  private handleStop(ctx: CommandContext): void {
    const provider = this.getProviderForConversation(ctx.conversationId);
    provider.interrupt(ctx.conversationId);
    this.reply(ctx, "已中斷目前操作");
  }

  private async handleResume(arg: string, ctx: CommandContext): Promise<void> {
    if (!arg) {
      this.reply(ctx, "請提供 session ID\n用法: /resume <session-id>");
      return;
    }

    // Fuzzy-match across ALL providers
    const needle = arg.toLowerCase();
    const matches: Array<{ providerId: string; sessionId: string }> = [];

    for (const provider of this.providers.values()) {
      for (const s of provider.listSessions()) {
        if (s.sessionId.toLowerCase().startsWith(needle)) {
          matches.push({ providerId: provider.id, sessionId: s.sessionId });
        }
      }
    }

    let sessionId: string;
    let targetProviderId: string;

    if (matches.length === 1) {
      sessionId = matches[0].sessionId;
      targetProviderId = matches[0].providerId;
    } else if (matches.length > 1) {
      const list = matches.map((m) => `  [${m.providerId}] ${m.sessionId.slice(0, 12)}…`).join("\n");
      this.reply(ctx, `多個 session 匹配 "${arg}":\n${list}\n請輸入更長的前綴`);
      return;
    } else {
      this.reply(ctx, `找不到匹配 "${arg}" 的 session\n用 /sessions 查看可用的 session ID`);
      return;
    }

    // Auto-switch provider if the matched session belongs to a different one
    const currentProvider = this.getProviderForConversation(ctx.conversationId);
    if (currentProvider.id !== targetProviderId) {
      currentProvider.interrupt(ctx.conversationId);
      this.providerOverrides.set(ctx.conversationId, targetProviderId);
      this.modelOverrides.delete(ctx.conversationId);
    }

    const provider = this.providers.get(targetProviderId)!;
    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    const ok = await provider.resumeSession(ctx.conversationId, sessionId, { cwd, model });
    if (!ok) {
      this.reply(ctx, "恢復失敗\n用 /sessions 查看可用的 session ID");
      return;
    }

    const switchNote = currentProvider.id !== targetProviderId
      ? `\nProvider 已切換到 ${provider.displayName}`
      : "";
    this.reply(ctx, `已恢復 session: ${sessionId.slice(0, 12)}${switchNote}`);
  }

  private async handleModel(arg: string, ctx: CommandContext): Promise<void> {
    const provider = this.getProviderForConversation(ctx.conversationId);
    const supported = provider.supportedModels();

    if (!arg) {
      const current = this.getModelForConversation(ctx.conversationId) ?? "default";
      const hint = supported ? `可用: ${supported.join(" / ")}` : "直接輸入模型名稱";
      this.reply(ctx, `目前模型: ${current}\n${hint}\n用法: /model <name>`);
      return;
    }

    // Case-insensitive exact match, then substring match
    const needle = arg.toLowerCase();
    let match = supported?.find((m) => m.toLowerCase() === needle);
    if (!match && supported) {
      const fuzzy = supported.filter((m) => m.toLowerCase().includes(needle));
      if (fuzzy.length === 1) {
        match = fuzzy[0];
      } else if (fuzzy.length > 1) {
        this.reply(ctx, `多個模型匹配 "${arg}": ${fuzzy.join(" / ")}\n請輸入更精確的名稱`);
        return;
      }
    }
    if (supported && !match) {
      this.reply(ctx, `不支援的模型: ${arg}\n可用: ${supported.join(" / ")}`);
      return;
    }
    const model = match ?? arg;

    this.modelOverrides.set(ctx.conversationId, model);
    await provider.resetSession(ctx.conversationId, {
      cwd: this.getCwdForConversation(ctx.conversationId),
      model,
    });
    this.onSessionReset?.(ctx.conversationId);

    this.reply(ctx, `已切換模型為 ${model}\n下次對話將使用新模型（上下文已重置）`);
  }

  private async handleCompact(ctx: CommandContext): Promise<void> {
    const provider = this.getProviderForConversation(ctx.conversationId);
    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    if (provider.type.startsWith("anthropic")) {
      // Anthropic providers: use native --resume --compact mechanism
      const info = provider.getSessionInfo(ctx.conversationId);
      if (!info) {
        this.reply(ctx, "目前無活躍的 session");
        return;
      }

      await provider.resetSession(ctx.conversationId, { cwd, model, compact: true });

      if (info.sessionId) {
        await provider.resumeSession(ctx.conversationId, info.sessionId, {
          cwd,
          model,
          compact: true,
        });
      }
    } else {
      // Non-Anthropic providers: use bridgeSessionStore.compact() + resetSession
      if (!this.sessionStore) {
        this.reply(ctx, "session store 未啟用，無法執行 /compact");
        return;
      }

      try {
        const agentCfg = this.config.agents.find((a) => a.name === this.agentName);
        const compactModel = agentCfg?.compactModel ?? model;
        await this.sessionStore.compact(ctx.conversationId, async (messages, existingSummary) => {
          const tokenBudget = getSummaryMaxTokens(compactModel);
          const conversationText = messages.map((m) => `${m.sender ?? m.role}: ${m.content}`).join("\n");
          const summaryPrompt = buildCompactPrompt(conversationText, tokenBudget, existingSummary);

          const compactResult = await provider.sendMessage({
            conversationId: `${ctx.conversationId}:compact`,
            content: summaryPrompt,
            cwd,
            model: compactModel,
            onChunk: () => {},
            systemPrompt: "You are a conversation summariser. Output only the summary, nothing else. Write in the same language as the conversation.",
          });
          return compactResult.text;
        }, { model: compactModel });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.reply(ctx, `compact 失敗，session 維持原狀：${msg}`);
        return;
      }

      // Compact succeeded — now reset the provider session; buildContext() will include the summary
      await provider.resetSession(ctx.conversationId, { cwd, model });
    }

    this.onSessionReset?.(ctx.conversationId);
    this.reply(ctx, "已壓縮對話上下文");
  }

  private handleUsage(ctx: CommandContext): void {
    const out: Record<string, unknown> = {};

    // Context: from live session (per-session)
    const provider = this.getProviderForConversation(ctx.conversationId);
    const usage = provider.getUsageInfo(ctx.conversationId);
    if (usage?.context) {
      const total = usage.context.contextWindow ?? 0;
      const pct = total ? Math.round((usage.context.contextTokens / total) * 100) : 0;
      out.context = { used: pct, total, percent: pct };
    }

    // Rate limits: Claude reads status file; other providers use rateLimits from getUsageInfo()
    if (provider.type.startsWith("anthropic")) {
      const statusFile = this.readStatusFile() as {
        limit5h?: { percent?: number; resetIn?: string };
        limit7d?: { percent?: number; resetIn?: string };
        model?: string;
        cost?: number;
      } | null;
      if (statusFile?.limit5h) out.limit5h = statusFile.limit5h;
      if (statusFile?.limit7d) out.limit7d = statusFile.limit7d;
      if (statusFile?.model) out.model = statusFile.model;
      if (statusFile?.cost !== undefined && statusFile.cost > 0) out.cost = statusFile.cost;
    } else if (usage?.rateLimits) {
      for (const rl of usage.rateLimits) {
        const percent = Math.round((rl.utilization ?? 0) * 100);
        const resetIn = rl.resetsAt ? this.formatResetIn(rl.resetsAt) : "";
        if (rl.rateLimitType === "five_hour") out.limit5h = { percent, resetIn };
        if (rl.rateLimitType === "seven_day") out.limit7d = { percent, resetIn };
      }
    }

    if (Object.keys(out).length === 0) {
      this.reply(ctx, "目前無使用資料");
      return;
    }

    this.reply(ctx, JSON.stringify(out));
  }

  private formatResetIn(epoch: number): string {
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

  /** Read Claude Code status line cache (rate limits, context window, cost). */
  private readStatusFile(): Record<string, unknown> | null {
    try {
      const raw = readFileSync("/tmp/claude-status.json", "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private handleCost(ctx: CommandContext): void {
    const provider = this.getProviderForConversation(ctx.conversationId);
    const cost = provider.getCostInfo(ctx.conversationId);

    if (!cost) {
      this.reply(ctx, "目前無使用資料");
      return;
    }

    const lines: string[] = [];

    if (cost.totalCostUsd !== undefined) {
      lines.push(`累計花費: $${cost.totalCostUsd.toFixed(4)} USD`);
    }

    if (cost.inputTokens !== undefined) {
      const total = (cost.inputTokens ?? 0) + (cost.outputTokens ?? 0);
      lines.push("**Token Usage:**");
      lines.push(`  Input:  ${(cost.inputTokens ?? 0).toLocaleString()} tokens (cached: ${(cost.cachedInputTokens ?? 0).toLocaleString()})`);
      lines.push(`  Output: ${(cost.outputTokens ?? 0).toLocaleString()} tokens`);
      lines.push(`  Total:  ${total.toLocaleString()} tokens`);
    }

    if (lines.length === 0) {
      this.reply(ctx, "目前無使用資料");
      return;
    }

    this.reply(ctx, lines.join("\n"));
  }

  // --- Notes Commands ---

  private async handleNotes(arg: string, ctx: CommandContext): Promise<void> {
    if (!ctx.listNotes) {
      this.reply(ctx, "Notes API 不可用");
      return;
    }

    try {
      const result = await ctx.listNotes({ limit: 20 });
      if (result.notes.length === 0) {
        this.reply(ctx, "目前沒有筆記\n用 /note-add <標題> | <內容> 來新增");
        return;
      }

      const lines = ["筆記列表:\n"];
      for (const note of result.notes) {
        const id = note.id.slice(0, 8);
        const creator = note.agentName ?? note.creatorName;
        const preview = note.content
          ? ` — ${note.content.slice(0, 60)}${note.content.length > 60 ? "…" : ""}`
          : "";
        lines.push(`\`${id}\` **${note.title}**${preview}  _(${creator})_`);
      }

      if (result.hasMore) {
        lines.push(`\n還有更多筆記…`);
      }

      this.reply(ctx, lines.join("\n"));
    } catch (err) {
      this.reply(ctx, `取得筆記失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleNoteAdd(arg: string, ctx: CommandContext): Promise<void> {
    if (!ctx.createNote) {
      this.reply(ctx, "Notes API 不可用");
      return;
    }

    if (!arg) {
      this.reply(ctx, "用法: /note-add <標題> | <內容>\n或: /note-add <標題>");
      return;
    }

    const pipeIdx = arg.indexOf("|");
    const title = pipeIdx === -1 ? arg.trim() : arg.slice(0, pipeIdx).trim();
    const content = pipeIdx === -1 ? undefined : arg.slice(pipeIdx + 1).trim();

    try {
      const note = await ctx.createNote({ title, content });
      this.reply(ctx, `已新增筆記: **${note.title}** (\`${note.id.slice(0, 8)}\`)`);
    } catch (err) {
      this.reply(ctx, `新增筆記失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleNoteEdit(arg: string, ctx: CommandContext): Promise<void> {
    if (!ctx.updateNote || !ctx.listNotes) {
      this.reply(ctx, "Notes API 不可用");
      return;
    }

    if (!arg) {
      this.reply(ctx, "用法: /note-edit <id> <新標題> | <新內容>");
      return;
    }

    const spaceIdx = arg.indexOf(" ");
    if (spaceIdx === -1) {
      this.reply(ctx, "用法: /note-edit <id> <新標題> | <新內容>");
      return;
    }

    const idPrefix = arg.slice(0, spaceIdx).toLowerCase();
    const rest = arg.slice(spaceIdx + 1).trim();

    // Resolve note ID by prefix
    const noteId = await this.resolveNoteId(idPrefix, ctx);
    if (!noteId) return;

    const pipeIdx = rest.indexOf("|");
    const title = pipeIdx === -1 ? rest.trim() : rest.slice(0, pipeIdx).trim();
    const content = pipeIdx === -1 ? undefined : rest.slice(pipeIdx + 1).trim();

    const body: { title?: string; content?: string } = {};
    if (title) body.title = title;
    if (content !== undefined) body.content = content;

    try {
      const note = await ctx.updateNote(noteId, body);
      this.reply(ctx, `已更新筆記: **${note.title}** (\`${note.id.slice(0, 8)}\`)`);
    } catch (err) {
      this.reply(ctx, `更新筆記失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleNoteDel(arg: string, ctx: CommandContext): Promise<void> {
    if (!ctx.deleteNote || !ctx.listNotes) {
      this.reply(ctx, "Notes API 不可用");
      return;
    }

    if (!arg) {
      this.reply(ctx, "用法: /note-del <id>\n用 /notes 查看筆記列表");
      return;
    }

    const noteId = await this.resolveNoteId(arg.trim().toLowerCase(), ctx);
    if (!noteId) return;

    try {
      await ctx.deleteNote(noteId);
      this.reply(ctx, `已刪除筆記 \`${noteId.slice(0, 8)}\``);
    } catch (err) {
      this.reply(ctx, `刪除筆記失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resolveNoteId(prefix: string, ctx: CommandContext): Promise<string | null> {
    try {
      const result = await ctx.listNotes!({ limit: 50 });
      const matches = result.notes.filter((n) => n.id.toLowerCase().startsWith(prefix));
      if (matches.length === 1) return matches[0].id;
      if (matches.length > 1) {
        const list = matches.map((n) => `  \`${n.id.slice(0, 8)}\` ${n.title}`).join("\n");
        this.reply(ctx, `多個筆記匹配 "${prefix}":\n${list}\n請輸入更長的前綴`);
        return null;
      }
      this.reply(ctx, `找不到匹配 "${prefix}" 的筆記\n用 /notes 查看筆記列表`);
      return null;
    } catch (err) {
      this.reply(ctx, `取得筆記失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // --- Spawn Command ---

  private handleSpawn(arg: string, ctx: CommandContext): void {
    if (!this.spawnManager || !this.agentName) {
      this.reply(ctx, "Spawn manager 未啟用");
      return;
    }

    const parts = arg.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    if (!sub || sub === "help") {
      this.reply(ctx, [
        "用法:",
        "  /spawn list — 列出所有 spawn 子任務",
        "  /spawn result <id> — 查看完整回傳內容",
        "  /spawn logs <id> — 查看執行過程 log",
        "  /spawn cancel <id> — 取消 spawn 子任務",
        "",
        "Spawn 透過 CLI 建立：",
        "  arinova-bridge spawn --agent <parent> --target <target> --context '...'",
      ].join("\n"));
      return;
    }

    switch (sub) {
      case "list":
      case "ls":
        this.handleSpawnList(ctx);
        return;
      case "result":
        this.handleSpawnResult(parts.slice(1), ctx);
        return;
      case "logs":
      case "log":
        this.handleSpawnLogs(parts.slice(1), ctx);
        return;
      case "cancel":
        this.handleSpawnCancel(parts.slice(1), ctx);
        return;
      default:
        this.reply(ctx, `未知的 spawn 子指令: ${sub}\n用法: /spawn list|result|logs|cancel`);
    }
  }

  private handleSpawnList(ctx: CommandContext): void {
    const jobs = this.spawnManager!.listByParent(this.agentName!);

    if (jobs.length === 0) {
      this.reply(ctx, "目前沒有 spawn 子任務");
      return;
    }

    const lines = ["Spawn Jobs:\n"];
    for (const job of jobs) {
      const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";
      const duration = job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : "—";
      const time = new Date(job.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      lines.push(`${statusIcon} \`${job.id}\`  → ${job.targetAgent}  ${job.status}  ${duration}`);
      lines.push(`   ${time}  ${job.context.slice(0, 60)}${job.context.length > 60 ? "…" : ""}`);
      if (job.result) {
        const firstLine = job.result.split("\n")[0].slice(0, 80);
        const truncated = job.result.length > 80;
        lines.push(`   Result: ${firstLine}${truncated ? `… (/spawn result ${job.id})` : ""}`);
      }
    }

    this.reply(ctx, lines.join("\n"));
  }

  private handleSpawnResult(parts: string[], ctx: CommandContext): void {
    const jobId = parts[0];
    if (!jobId) {
      this.reply(ctx, "用法: /spawn result <id>");
      return;
    }

    const job = this.spawnManager!.getJob(jobId);
    if (!job || job.parentAgent !== this.agentName) {
      this.reply(ctx, `找不到 spawn job "${jobId}"`);
      return;
    }

    const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";
    const duration = job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : "—";
    const time = new Date(job.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

    const lines = [
      `${statusIcon} Spawn Job: \`${job.id}\``,
      `Target: ${job.targetAgent}  Status: ${job.status}  Duration: ${duration}`,
      `Created: ${time}`,
      "",
      "**Context:**",
      job.context,
    ];

    if (job.result) {
      lines.push("", "**Result:**", job.result);
    } else if (job.status === "running") {
      lines.push("", "_(Job is still running — no result yet)_");
    } else {
      lines.push("", "_(No result)_");
    }

    this.reply(ctx, lines.join("\n"));
  }

  private handleSpawnLogs(parts: string[], ctx: CommandContext): void {
    const jobId = parts[0];
    if (!jobId) {
      this.reply(ctx, "用法: /spawn logs <id>");
      return;
    }

    const job = this.spawnManager!.getJob(jobId);
    if (!job || job.parentAgent !== this.agentName) {
      this.reply(ctx, `找不到 spawn job "${jobId}"`);
      return;
    }

    const logs = this.spawnManager!.getLogs(jobId);
    const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";

    if (logs.length === 0) {
      const hint = job.status === "running" ? "（尚無 log — 任務仍在執行中）" : "（無 log 紀錄）";
      this.reply(ctx, `${statusIcon} Spawn Logs: \`${job.id}\`  ${job.status}\n\n${hint}`);
      return;
    }

    const lines = [`${statusIcon} Spawn Logs: \`${job.id}\`  ${job.status}\n`];
    for (const entry of logs) {
      const time = new Date(entry.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      lines.push(`**[${time}]**`);
      lines.push(entry.content);
    }

    this.reply(ctx, lines.join("\n"));
  }

  private handleSpawnCancel(parts: string[], ctx: CommandContext): void {
    const target = parts[0];
    if (!target) {
      this.reply(ctx, "用法: /spawn cancel <id>");
      return;
    }

    const cancelled = this.spawnManager!.cancel(target);
    if (cancelled) {
      this.reply(ctx, `已取消 spawn job \`${target}\``);
    } else {
      this.reply(ctx, `找不到或無法取消 spawn job "${target}"（可能已完成）`);
    }
  }

  // --- Fork Command ---

  private handleFork(arg: string, ctx: CommandContext): void {
    if (!this.forkManager || !this.agentName) {
      this.reply(ctx, "Fork manager 未啟用");
      return;
    }

    const parts = arg.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    if (!sub || sub === "help") {
      this.reply(ctx, [
        "用法:",
        "  /fork <task> — Fork 分身執行任務",
        "  /fork list — 列出所有 fork 任務",
        "  /fork cancel <id> — 取消 fork 任務",
        "",
        "也可透過 CLI 建立：",
        "  arinova-bridge fork --agent <name> --task '...'",
      ].join("\n"));
      return;
    }

    switch (sub) {
      case "list":
      case "ls":
        this.handleForkList(ctx);
        return;
      case "cancel":
        this.handleForkCancel(parts.slice(1), ctx);
        return;
      default:
        // Treat entire arg as fork task
        this.handleForkCreate(arg, ctx);
    }
  }

  private handleForkCreate(task: string, ctx: CommandContext): void {
    try {
      const job = this.forkManager!.fork({
        parentAgent: this.agentName!,
        task,
      });
      this.reply(ctx, `已建立 fork \`${job.id}\`\n任務: ${task.slice(0, 100)}${task.length > 100 ? "…" : ""}\n\n分身正在背景執行，完成後會自動回報結果。`);
    } catch (err) {
      this.reply(ctx, `Fork 建立失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleForkList(ctx: CommandContext): void {
    const jobs = this.forkManager!.listByParent(this.agentName!);

    if (jobs.length === 0) {
      this.reply(ctx, "目前沒有 fork 任務");
      return;
    }

    const lines = ["Fork Jobs:\n"];
    for (const job of jobs) {
      const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";
      const duration = job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : "—";
      const time = new Date(job.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      lines.push(`${statusIcon} \`${job.id}\`  ${job.status}  ${duration}`);
      lines.push(`   ${time}  ${job.task.slice(0, 60)}${job.task.length > 60 ? "…" : ""}`);
    }

    this.reply(ctx, lines.join("\n"));
  }

  private handleForkCancel(parts: string[], ctx: CommandContext): void {
    const target = parts[0];
    if (!target) {
      this.reply(ctx, "用法: /fork cancel <id>");
      return;
    }

    const cancelled = this.forkManager!.cancel(target);
    if (cancelled) {
      this.reply(ctx, `已取消 fork job \`${target}\``);
    } else {
      this.reply(ctx, `找不到或無法取消 fork job "${target}"（可能已完成）`);
    }
  }

  // --- Search Command ---

  private handleSearch(arg: string, ctx: CommandContext): void {
    if (!this.sessionStore) {
      this.reply(ctx, "搜尋功能不可用");
      return;
    }

    if (!arg) {
      this.reply(ctx, "用法: /search <關鍵字>\n例如: /search SQLite session");
      return;
    }

    const results = this.sessionStore.search(arg, 10);

    if (results.length === 0) {
      this.reply(ctx, `找不到包含「${arg}」的歷史對話`);
      return;
    }

    const lines = [`搜尋「${arg}」— 找到 ${results.length} 筆結果:\n`];
    for (const msg of results) {
      const sender = msg.sender ?? msg.role;
      const time = new Date(msg.timestamp).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      const preview = msg.content.length > 120
        ? msg.content.slice(0, 120) + "…"
        : msg.content;
      lines.push(`**${sender}** _(${time})_\n${preview}\n`);
    }

    this.reply(ctx, lines.join("\n"));
  }

  // --- Provider Command ---

  private async handleProvider(arg: string, ctx: CommandContext): Promise<void> {
    if (!arg) {
      const current = this.getProviderForConversation(ctx.conversationId);
      const configuredIds = this.getConfiguredProviderIds();
      const lines: string[] = [];
      for (const id of configuredIds) {
        const provider = this.providers.get(id);
        const isCurrent = id === current.id;
        const prefix = isCurrent ? "→ " : "  ";
        if (provider) {
          lines.push(`${prefix}${id} (${provider.displayName})`);
        } else {
          lines.push(`${prefix}${id} ⚠ 無法啟動`);
        }
      }
      this.reply(ctx, `目前 Provider: ${current.displayName}\n\n${lines.join("\n")}\n\n用法: /provider <name>`);
      return;
    }

    const targetId = arg;
    const configuredIds = this.getConfiguredProviderIds();
    const targetProvider = this.providers.get(targetId);

    if (!targetProvider) {
      if (configuredIds.includes(targetId)) {
        this.reply(ctx, `Provider ${arg} 已設定但無法啟動，請檢查 CLI 是否已安裝`);
      } else {
        const available = configuredIds.join(" / ");
        this.reply(ctx, `不支援或未啟用的 provider: ${arg}\n可用: ${available}`);
      }
      return;
    }

    // 1. Compact current session to preserve context across provider switch
    const currentProvider = this.getProviderForConversation(ctx.conversationId);
    let compactNote = "";
    if (currentProvider.id !== targetId && this.sessionStore) {
      try {
        const cwd = this.getCwdForConversation(ctx.conversationId);
        const model = this.getModelForConversation(ctx.conversationId);
        const agentCfg = this.config.agents.find((a) => a.name === this.agentName);
        const compactModel = agentCfg?.compactModel ?? model;
        await this.sessionStore.compact(ctx.conversationId, async (messages, existingSummary) => {
          const tokenBudget = getSummaryMaxTokens(compactModel);
          const conversationText = messages.map((m) => `${m.sender ?? m.role}: ${m.content}`).join("\n");
          const summaryPrompt = buildCompactPrompt(conversationText, tokenBudget, existingSummary);

          const compactResult = await currentProvider.sendMessage({
            conversationId: `${ctx.conversationId}:compact`,
            content: summaryPrompt,
            cwd,
            model: compactModel,
            onChunk: () => {},
            systemPrompt: "You are a conversation summariser. Output only the summary, nothing else. Write in the same language as the conversation.",
          });
          return compactResult.text;
        }, { model: compactModel });
        compactNote = "\nContext 已透過 compact 轉移";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        compactNote = `\n⚠️ Context compact 失敗（${msg}），對話摘要未轉移`;
      }
    }

    // 2. Interrupt current provider
    if (currentProvider.id !== targetId) {
      currentProvider.interrupt(ctx.conversationId);
    }

    // 3. Reset target provider session to avoid stale thread/session reuse
    const cwd = this.getCwdForConversation(ctx.conversationId);
    await targetProvider.resetSession(ctx.conversationId, { cwd });

    // 4. Set override
    this.providerOverrides.set(ctx.conversationId, targetId);

    // 5. Clear model override (different providers have different models)
    this.modelOverrides.delete(ctx.conversationId);

    // 6. Clear smart-injection tracking so next message re-injects context
    this.onSessionReset?.(ctx.conversationId);

    // 7. Preserve cwd override (cwd is universal)

    this.reply(
      ctx,
      `已切換到 ${targetProvider.displayName}\n模型設定已重置\n工作目錄: ${this.getCwdForConversation(ctx.conversationId)}${compactNote}`,
    );
  }
}
