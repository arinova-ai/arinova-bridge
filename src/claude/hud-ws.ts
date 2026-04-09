import type { Logger } from "../util/logger.js";

export type HudData = {
  context?: { used: number; total: number; percent: number };
  limit5h?: { percent: number; resetIn: string };
  limit7d?: { percent: number; resetIn: string };
  model?: string;
};

export type TaskData =
  | { status: "started"; task: string }
  | { status: "completed"; durationMs?: number; costUsd?: number; numTurns?: number };

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-5-20250514": "Sonnet 4.5",
  "claude-opus-4-20250514": "Opus 4",
};

export function formatModelName(modelId: string): string {
  return MODEL_NAMES[modelId] ?? modelId;
}

/**
 * WebSocket client that pushes HUD updates (context, rate limits, model)
 * to the arinova-chat backend.
 *
 * Single global connection with automatic reconnect (exponential backoff).
 */
export class HudWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private logger: Logger;
  private closed = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, token: string, logger: Logger) {
    this.url = url;
    this.token = token;
    this.logger = logger;
  }

  connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
      } as unknown as string[]);

      this.ws.addEventListener("open", () => {
        this.logger.info(`hud-ws: connected to ${this.url}`);
        this.reconnectDelay = 1000;
      });

      this.ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as { type?: string };
          if (msg.type === "ping") {
            this.ws?.send(JSON.stringify({ type: "pong" }));
          }
        } catch { /* ignore non-JSON messages */ }
      });

      this.ws.addEventListener("close", (ev: CloseEvent) => {
        this.logger.info(`hud-ws: closed (code=${ev.code} reason=${ev.reason || "none"})`);
        this.ws = null;
        if (!this.closed) this.scheduleReconnect();
      });

      this.ws.addEventListener("error", (ev: Event) => {
        const errObj = ev as unknown as Record<string, unknown>;
        const error = errObj.error as Error | undefined;
        const msg = error?.message ?? errObj.message ?? errObj.type ?? "unknown";
        this.logger.warn(`hud-ws: error connecting to ${this.url} — ${msg}`);
      });
    } catch (err) {
      this.logger.error(`hud-ws: failed to connect — ${err instanceof Error ? err.message : String(err)}`);
      if (!this.closed) this.scheduleReconnect();
    }
  }

  send(conversationId: string, data: HudData): void {
    const msg = { type: "hud_update", conversationId, data };
    this.logger.info(`hud-ws: hud_update ${JSON.stringify(msg)}`);
    this.rawSend(msg);
  }

  sendTask(agentName: string, data: TaskData): void {
    const msg = { type: "task_update", agentName, data };
    this.logger.info(`hud-ws: task_update ${JSON.stringify(msg)}`);
    this.rawSend(msg);
  }

  private rawSend(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.logger.warn(`hud-ws: send failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.logger.info(`hud-ws: reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }
}
