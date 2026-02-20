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
      case "provider":
        await this.handleProvider(arg, ctx);
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
    ];

    // Add /compact only if an Anthropic-type provider is configured
    if (this.hasProviderType("anthropic")) {
      skills.push({ id: "compact", name: "Compact", description: "壓縮對話上下文 (Anthropic only)" });
    }

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
    const allSessions: Array<{
      providerId: string;
      sessionId: string;
      alive: boolean;
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
      const status = s.alive ? "🟢" : "⚪";
      const id = s.sessionId.slice(0, 12);
      const model = s.model ?? "default";
      lines.push(`${status} [${s.providerId}] ${id}  ${model}  ${s.cwd}`);
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
    ];

    if (this.hasProviderType("anthropic")) {
      lines.push("/compact — 壓縮對話上下文 (Anthropic only)");
    }

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
    const provider = this.getProviderForConversation(ctx.conversationId);

    if (!arg) {
      this.reply(ctx, "請提供 session ID\n用法: /resume <session-id>");
      return;
    }

    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    const ok = await provider.resumeSession(ctx.conversationId, arg, { cwd, model });
    if (!ok) {
      this.reply(ctx, "恢復失敗\n用 /sessions 查看可用的 session ID");
      return;
    }

    this.reply(ctx, `已恢復 session: ${arg.slice(0, 12)}`);
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

    // Case-insensitive match, but use the original casing from supported list
    const match = supported?.find((m) => m.toLowerCase() === arg.toLowerCase());
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
