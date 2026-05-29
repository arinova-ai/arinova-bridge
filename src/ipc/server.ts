import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { IpcRequest, IpcResponse } from "./types.js";
import { subscribeWatch } from "./router.js";
import type { Logger } from "../util/logger.js";
import { getErrorMessage } from "../util/errors.js";

const SOCKET_PATH = path.join(homedir(), ".arinova-bridge", "bridge.sock");

export function startIpcServer(
  handler: (req: IpcRequest) => Promise<IpcResponse>,
  logger: Logger,
): () => void {
  // Remove stale socket from a previous crash
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* not found */ }

  const server = net.createServer((conn) => {
    let buf = "";

    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nlIdx = buf.indexOf("\n");
      if (nlIdx === -1) return;

      const line = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 1);

      let req: IpcRequest;
      try {
        req = JSON.parse(line) as IpcRequest;
      } catch {
        const errResp: IpcResponse = { id: 0, error: { code: -32700, message: "Parse error" } };
        conn.end(JSON.stringify(errResp) + "\n");
        return;
      }

      // Watch: keep connection alive and stream events
      if (req.method === "watch") {
        const unsubscribe = subscribeWatch((eventLine) => {
          if (!conn.destroyed) {
            conn.write(eventLine + "\n");
          }
        });
        conn.on("close", unsubscribe);
        conn.on("error", unsubscribe);
        // Send ack
        conn.write(JSON.stringify({ id: req.id, result: { streaming: true } }) + "\n");
        return;
      }

      handler(req)
        .then((resp) => {
          conn.end(JSON.stringify(resp) + "\n");
        })
        .catch((err) => {
          const errResp: IpcResponse = {
            id: req.id,
            error: { code: -32603, message: getErrorMessage(err) },
          };
          conn.end(JSON.stringify(errResp) + "\n");
        });
    });

    conn.on("error", (err) => {
      logger.warn(`ipc: connection error — ${err.message}`);
    });
  });

  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch { /* best effort */ }
    logger.info(`ipc: listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    logger.error(`ipc: server error — ${err.message}`);
  });

  return () => {
    server.close();
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
  };
}
