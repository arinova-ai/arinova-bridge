import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { IpcRequest, IpcResponse } from "./types.js";

const SOCKET_PATH = path.join(homedir(), ".arinova-bridge", "bridge.sock");
const TIMEOUT_MS = 60_000;

function ensureSocket(): void {
  if (!fs.existsSync(SOCKET_PATH)) {
    throw new Error("Bridge is not running (no socket found). Start it with: arinova-bridge start");
  }
}

export function sendIpcRequest(req: IpcRequest): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    ensureSocket();

    const conn = net.createConnection(SOCKET_PATH);
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error("IPC request timed out (60s)"));
      }
    }, TIMEOUT_MS);

    conn.on("connect", () => {
      conn.write(JSON.stringify(req) + "\n");
    });

    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nlIdx = buf.indexOf("\n");
      if (nlIdx === -1) return;

      const line = buf.slice(0, nlIdx);
      clearTimeout(timer);
      settled = true;
      conn.destroy();

      try {
        resolve(JSON.parse(line) as IpcResponse);
      } catch {
        reject(new Error("Invalid JSON response from bridge"));
      }
    });

    conn.on("error", (err) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error(`IPC connection failed: ${err.message}`));
      }
    });

    conn.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("Connection closed before response"));
      }
    });
  });
}

/**
 * Connect to bridge IPC and stream watch events.
 * Calls onEvent for each newline-delimited JSON event.
 * Returns a cleanup function to disconnect.
 */
export function streamWatch(onEvent: (line: string) => void): () => void {
  ensureSocket();

  const conn = net.createConnection(SOCKET_PATH);
  let buf = "";

  conn.on("connect", () => {
    const req: IpcRequest = { id: 0, method: "watch" };
    conn.write(JSON.stringify(req) + "\n");
  });

  conn.on("data", (chunk) => {
    buf += chunk.toString();
    let nlIdx: number;
    while ((nlIdx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 1);
      if (line.trim()) onEvent(line);
    }
  });

  conn.on("error", () => {
    process.exit(1);
  });

  conn.on("close", () => {
    process.exit(0);
  });

  return () => conn.destroy();
}
