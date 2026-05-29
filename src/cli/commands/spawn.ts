import { ipcError, parseFlag } from "../flags.js";
import { renderSpawnList, renderSpawnLogs, renderSpawnResult } from "../renderers.js";
import type { SpawnListRecord, SpawnLogsRecord, SpawnResultRecord } from "../renderers.js";

export async function cmdSpawn(args: string[]): Promise<void> {
  const { sendIpcRequest } = await import("../../ipc/client.js");
  const sub = args[0]?.toLowerCase();

  if (sub === "logs") {
    const id = parseFlag(args, "--id") ?? args[1];
    if (!id) {
      console.error("Usage: arinova-bridge spawn logs --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "spawn-logs", params: { id } });
    if ("error" in resp) ipcError(resp);
    console.log(renderSpawnLogs(resp.result as SpawnLogsRecord));
  } else if (sub === "cancel") {
    const id = parseFlag(args, "--id");
    if (!id) {
      console.error("Usage: arinova-bridge spawn cancel --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "spawn-cancel", params: { id } });
    if ("error" in resp) ipcError(resp);
    console.log(`Cancelled spawn job: ${id}`);
  } else if (sub === "result") {
    const id = parseFlag(args, "--id") ?? args[1];
    if (!id) {
      console.error("Usage: arinova-bridge spawn result --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "spawn-result", params: { id } });
    if ("error" in resp) ipcError(resp);
    console.log(renderSpawnResult(resp.result as SpawnResultRecord));
  } else if (sub === "list" || !sub) {
    const agent = parseFlag(args, "--agent");
    const params: { agent?: string } = {};
    if (agent) params.agent = agent;

    const resp = await sendIpcRequest({ id: 1, method: "spawn-list", params });
    if ("error" in resp) ipcError(resp);
    console.log(renderSpawnList(resp.result as SpawnListRecord[]));
  } else {
    const agent = parseFlag(args, "--agent");
    const target = parseFlag(args, "--target");
    const context = parseFlag(args, "--context");
    const model = parseFlag(args, "--model");
    const cwd = parseFlag(args, "--cwd");

    if (!agent || !target || !context) {
      console.error(
        "Usage: arinova-bridge spawn --agent <parent> --target <target> --context 'task description' [--model <model>] [--cwd <path>]",
      );
      process.exit(1);
    }

    const params: { parentAgent: string; targetAgent: string; context: string; model?: string; cwd?: string } = {
      parentAgent: agent,
      targetAgent: target,
      context,
    };
    if (model) params.model = model;
    if (cwd) params.cwd = cwd;

    const resp = await sendIpcRequest({ id: 1, method: "spawn-add", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { id: string; parentAgent: string; targetAgent: string; status: string };
    console.log(`Spawned: ${r.id}`);
    console.log(`  ${r.parentAgent} → ${r.targetAgent}  status=${r.status}`);
    console.log(`\nUse 'arinova-bridge spawn list' to check progress.`);
  }
}
