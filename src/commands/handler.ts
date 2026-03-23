import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Provider } from "../providers/types.js";
import type { BridgeConfig } from "../config.js";
import type { CommandContext, CommandResult } from "./types.js";

export class CommandHandler {
  private providers: Map<string, Provider>;
  private config: BridgeConfig;

  /** Per-conversation provider overrides (set by /provider). */
  private providerOverrides = new Map<string, string>();
  /** Per-conversation cwd overrides (set by /new). */
  private cwdOverrides = new Map<string, string>();
  /** Per-conversation model overrides (set by /model). */
  private modelOverrides = new Map<string, string>();

  constructor(providers: Map<string, Provider>, config: BridgeConfig) {
    this.providers = providers;
    this.config = config;
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
      case "usage":
        this.handleUsage(ctx);
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
    const skills = [
      { id: "new", name: "New", description: "開新工作階段 (可帶路徑: /new ~/project)" },
      { id: "sessions", name: "Sessions", description: "列出所有 sessions" },
      { id: "status", name: "Status", description: "查看目前 session 狀態" },
      { id: "help", name: "Help", description: "列出所有可用指令" },
      { id: "stop", name: "Stop", description: "中斷目前正在執行的操作" },
      { id: "resume", name: "Resume", description: "恢復 session (可帶 ID: /resume <id>)" },
      { id: "model", name: "Model", description: "切換模型" },
      { id: "cost", name: "Cost", description: "顯示累計花費 / token 用量" },
      { id: "usage", name: "Usage", description: "顯示 context 用量與 rate limit 狀態" },
    ];

    // Add /compact only if an Anthropic-type provider is configured
    if (this.hasProviderType("anthropic")) {
      skills.push({ id: "compact", name: "Compact", description: "壓縮對話上下文 (Anthropic only)" });
    }

    skills.push(
      { id: "notes", name: "Notes", description: "列出對話筆記" },
      { id: "note-add", name: "Note Add", description: "新增筆記 (/note-add 標題 | 內容)" },
      { id: "note-edit", name: "Note Edit", description: "編輯筆記 (/note-edit <id> 標題 | 內容)" },
      { id: "note-del", name: "Note Del", description: "刪除筆記 (/note-del <id>)" },
    );

    const ids = this.getConfiguredProviderIds().join(" / ");
    skills.push({ id: "provider", name: "Provider", description: `切換 provider (${ids})` });

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
      "/resume [id] — 恢復 session",
      "/model [name] — 切換模型",
      "/cost — 顯示累計花費 / token 用量",
      "/usage — 顯示 context 用量與 rate limit 狀態",
    ];

    if (this.hasProviderType("anthropic")) {
      lines.push("/compact — 壓縮對話上下文 (Anthropic only)");
    }

    lines.push(
      "/notes — 列出對話筆記",
      "/note-add <標題> | <內容> — 新增筆記",
      "/note-edit <id> <標題> | <內容> — 編輯筆記",
      "/note-del <id> — 刪除筆記",
    );

    const ids = this.getConfiguredProviderIds().join(" / ");
    lines.push(`/provider [name] — 切換 provider (${ids})`);

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

    this.reply(ctx, `已切換模型為 ${model}\n下次對話將使用新模型（上下文已重置）`);
  }

  private async handleCompact(ctx: CommandContext): Promise<void> {
    const provider = this.getProviderForConversation(ctx.conversationId);

    // Compact is only supported by Anthropic-type providers
    if (!provider.type.startsWith("anthropic")) {
      this.reply(ctx, "此 provider 不支援 /compact");
      return;
    }

    const info = provider.getSessionInfo(ctx.conversationId);
    if (!info) {
      this.reply(ctx, "目前無活躍的 session");
      return;
    }

    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    // For anthropic-oauth: destroy and recreate with resume + compact
    await provider.resetSession(ctx.conversationId, { cwd, model, compact: true });

    // Try to resume with compact flag
    if (info.sessionId) {
      await provider.resumeSession(ctx.conversationId, info.sessionId, {
        cwd,
        model,
        compact: true,
      });
    }

    this.reply(ctx, "已壓縮對話上下文");
  }

  private handleUsage(ctx: CommandContext): void {
    const provider = this.getProviderForConversation(ctx.conversationId);
    const usage = provider.getUsageInfo(ctx.conversationId);

    if (!usage) {
      // Fallback: show cost info if available
      const cost = provider.getCostInfo(ctx.conversationId);
      if (cost?.totalCostUsd !== undefined) {
        this.reply(ctx, `此 provider 不支援詳細用量資訊\n累計花費: $${cost.totalCostUsd.toFixed(4)}`);
      } else {
        this.reply(ctx, "目前無使用資料（需先發送訊息）");
      }
      return;
    }

    const lines: string[] = [];

    // Context usage
    if (usage.context) {
      const used = usage.context.contextTokens;
      const window = usage.context.contextWindow;
      if (window) {
        const pct = ((used / window) * 100).toFixed(1);
        lines.push(`Context: ${this.fmtTokens(used)} / ${this.fmtTokens(window)} (${pct}%)`);
      } else {
        lines.push(`Context: ${this.fmtTokens(used)}`);
      }
      if (usage.context.maxOutputTokens) {
        lines.push(`Max output: ${this.fmtTokens(usage.context.maxOutputTokens)}`);
      }
    } else {
      lines.push("Context: 尚無資料（需先發送訊息）");
    }

    // Rate limits
    const typeLabels: Record<string, string> = { five_hour: "5H Limit", seven_day: "7D Limit" };
    if (usage.rateLimits?.length) {
      for (const rl of usage.rateLimits) {
        lines.push("");
        const label = typeLabels[rl.rateLimitType] ?? rl.rateLimitType;
        const statusIcon = rl.status === "allowed" ? "🟢" : rl.status === "allowed_warning" ? "🟡" : "🔴";
        const pct = rl.utilization !== undefined ? ` ${(rl.utilization * 100).toFixed(0)}% used` : "";
        lines.push(`${statusIcon} ${label}${pct}`);
        if (rl.resetsAt) {
          lines.push(`  重置: ${this.fmtResetTime(rl.resetsAt)}`);
        }
        // Show bridge-local window stats for five_hour
        if (rl.rateLimitType === "five_hour" && usage.window) {
          const w = usage.window;
          lines.push(`  本 session: Input ${this.fmtTokens(w.inputTokens)} / Output ${this.fmtTokens(w.outputTokens)} / $${w.costUsd.toFixed(4)} / ${w.turns} turns`);
        }
        if (rl.overageStatus) {
          const overageIcon = rl.overageStatus === "allowed" ? "🟢" : "🔴";
          lines.push(`  Overage: ${overageIcon} ${rl.overageStatus}${rl.isUsingOverage ? " (使用中)" : ""}`);
        }
      }
    } else if (usage.window) {
      lines.push("");
      lines.push("Rate limit: 尚無資料");
      const w = usage.window;
      lines.push(`  本 session: Input ${this.fmtTokens(w.inputTokens)} / Output ${this.fmtTokens(w.outputTokens)} / $${w.costUsd.toFixed(4)} / ${w.turns} turns`);
    }

    // Total cost
    if (usage.totalCostUsd !== undefined && usage.totalCostUsd > 0) {
      lines.push("");
      lines.push(`Session 累計: $${usage.totalCostUsd.toFixed(4)}`);
    }

    this.reply(ctx, lines.join("\n"));
  }

  private fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private fmtResetTime(epochSec: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = epochSec - now;
    if (diff <= 0) return "已重置";
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (h > 0) return `${h}h ${m}m 後`;
    return `${m}m 後`;
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

    // 1. Interrupt current provider
    const currentProvider = this.getProviderForConversation(ctx.conversationId);
    if (currentProvider.id !== targetId) {
      currentProvider.interrupt(ctx.conversationId);
    }

    // 2. Set override
    this.providerOverrides.set(ctx.conversationId, targetId);

    // 3. Clear model override (different providers have different models)
    this.modelOverrides.delete(ctx.conversationId);

    // 4. Preserve cwd override (cwd is universal)

    this.reply(
      ctx,
      `已切換到 ${targetProvider.displayName}\n模型設定已重置\n工作目錄: ${this.getCwdForConversation(ctx.conversationId)}`,
    );
  }
}
