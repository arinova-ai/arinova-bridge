import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ApprovalResponse,
} from "./types.js";
import type { Logger } from "../util/logger.js";

const DEFAULT_TIMEOUT_MS = 60_000;

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

/**
 * JSON-RPC 2.0 client over newline-delimited JSON streams.
 * Handles request/response matching, notification routing, and
 * server-to-client request auto-approval.
 */
export class CodexRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private stdin: Writable;
  private logger: Logger;
  private timeoutMs: number;
  private closed = false;

  constructor(
    stdin: Writable,
    stdout: Readable,
    logger: Logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.stdin = stdin;
    this.logger = logger;
    this.timeoutMs = timeoutMs;

    const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    rl.on("close", () => this.handleClose());
  }

  /** Send a request and wait for the response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("RPC client is closed"));
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = { id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (id=${id})`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.writeLine(msg);
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { method };
    if (params !== undefined) msg.params = params;
    this.writeLine(msg);
  }

  /** Register a handler for server notifications. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Register a handler for server-to-client requests. */
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  /** Reject all pending requests (used on shutdown/crash). */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private writeLine(msg: unknown): void {
    try {
      this.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.logger.error(`rpc-client: write error: ${err}`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logger.warn(`rpc-client: unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    // Response to our request
    if (id !== undefined && (hasResult || hasError)) {
      const pending = this.pending.get(id);
      if (!pending) {
        this.logger.warn(`rpc-client: response for unknown id=${id}`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (hasError) {
        const err = msg.error as { message?: string; code?: number };
        pending.reject(new Error(`RPC error (${err.code}): ${err.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-to-client request (has id + method, needs response)
    if (id !== undefined && method) {
      void this.handleServerRequest(id, method, msg.params);
      return;
    }

    // Notification (has method, no id)
    if (method && id === undefined) {
      const handler = this.notificationHandlers.get(method);
      if (handler) {
        try {
          handler(msg.params);
        } catch (err) {
          this.logger.error(`rpc-client: notification handler error (${method}): ${err}`);
        }
      }
      return;
    }

    this.logger.warn(`rpc-client: unrecognized message: ${line.slice(0, 200)}`);
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.serverRequestHandlers.get(method);
    let result: unknown;

    if (handler) {
      try {
        result = await handler(params);
      } catch (err) {
        this.logger.error(`rpc-client: server request handler error (${method}): ${err}`);
        result = { decision: "accept" } satisfies ApprovalResponse;
      }
    } else {
      // Fallback: auto-approve any unhandled server request
      this.logger.info(`rpc-client: auto-approving unhandled server request: ${method}`);
      result = { decision: "accept" } satisfies ApprovalResponse;
    }

    this.writeLine({ id, result });
  }

  private handleClose(): void {
    this.closed = true;
    this.rejectAll("RPC connection closed");
  }
}
