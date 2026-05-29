import { hasFlag, ipcError, parseFlag } from "../flags.js";
import { renderForkList, type ForkListRecord } from "../renderers.js";

export async function cmdFork(args: string[]): Promise<void> {
  const { sendIpcRequest } = await import("../../ipc/client.js");
  const sub = args[0]?.toLowerCase();

  if (sub === "cancel") {
    const id = parseFlag(args, "--id");
    if (!id) {
      console.error("Usage: arinova-bridge fork cancel --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "fork-cancel", params: { id } });
    if ("error" in resp) ipcError(resp);
    console.log(`Cancelled fork job: ${id}`);
  } else if (sub === "list" || (!sub && !hasFlag(args, "--agent"))) {
    const agent = parseFlag(args, "--agent");
    const params: { agent?: string } = {};
    if (agent) params.agent = agent;

    const resp = await sendIpcRequest({ id: 1, method: "fork-list", params });
    if ("error" in resp) ipcError(resp);
    console.log(renderForkList(resp.result as ForkListRecord[]));
  } else {
    const agent = parseFlag(args, "--agent");
    const task = parseFlag(args, "--task");
    const model = parseFlag(args, "--model");
    const cwd = parseFlag(args, "--cwd");

    if (!agent || !task) {
      console.error(
        "Usage: arinova-bridge fork --agent <name> --task 'task description' [--model <model>] [--cwd <path>]",
      );
      process.exit(1);
    }

    const params: { agent: string; task: string; model?: string; cwd?: string } = { agent, task };
    if (model) params.model = model;
    if (cwd) params.cwd = cwd;

    const resp = await sendIpcRequest({ id: 1, method: "fork-add", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { id: string; parentAgent: string; status: string };
    console.log(`Forked: ${r.id}`);
    console.log(`  Agent: ${r.parentAgent}  status=${r.status}`);
    console.log(`\nUse 'arinova-bridge fork list' to check progress.`);
  }
}
