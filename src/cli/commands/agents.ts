import { hasFlag, ipcError, parseFlag } from "../flags.js";
import { renderTaskHistoryRecord, type TaskHistoryRecord } from "../renderers.js";

export async function cmdAgents(args: string[]): Promise<void> {
  const { sendIpcRequest, streamWatch } = await import("../../ipc/client.js");
  const deliver = parseFlag(args, "--deliver");
  const status = parseFlag(args, "--status");
  const ping = parseFlag(args, "--ping");
  const cost = parseFlag(args, "--cost");
  const stop = parseFlag(args, "--stop");
  const reset = parseFlag(args, "--reset");
  const handoff = parseFlag(args, "--handoff");
  const history = parseFlag(args, "--history");
  const watch = hasFlag(args, "--watch");
  const content = parseFlag(args, "--content");
  const source = parseFlag(args, "--source") ?? process.env.ARINOVA_AGENT_NAME;
  const cwd = parseFlag(args, "--cwd");
  const model = parseFlag(args, "--model");
  const wait = parseFlag(args, "--wait");
  const costAll = hasFlag(args, "--cost");

  if (deliver) {
    if (!content) {
      console.error('Missing --content flag.\nUsage: arinova-bridge agents --deliver <name> --content "message"');
      process.exit(1);
    }
    const params: { target: string; content: string; source?: string; cwd?: string; model?: string; wait?: boolean } = {
      target: deliver,
      content,
    };
    if (source) params.source = source;
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    if (wait === "false") params.wait = false;

    const resp = await sendIpcRequest({ id: 1, method: "deliver", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { agent: string; text?: string; durationMs?: number; queued?: boolean };
    if (r.queued) {
      console.log(`[${r.agent}] Message queued (fire-and-forget)`);
    } else {
      console.log(`[${r.agent}] (${r.durationMs}ms)\n${r.text}`);
    }
  } else if (status) {
    const resp = await sendIpcRequest({ id: 1, method: "agent-status", params: { target: status } });
    if ("error" in resp) ipcError(resp);
    const s = resp.result as {
      name: string;
      provider: string;
      providerDisplayName: string;
      cwd: string;
      model: string;
      activeSessions: number;
      sessions: Array<{ sessionId: string; status: string; cwd: string; model: string }>;
    };
    console.log(`Agent: ${s.name}`);
    console.log(`Provider: ${s.providerDisplayName} (${s.provider})`);
    console.log(`CWD: ${s.cwd}`);
    console.log(`Model: ${s.model}`);
    console.log(`Active Sessions: ${s.activeSessions}`);
    if (s.sessions.length > 0) {
      console.log("\nSessions:");
      for (const sess of s.sessions) {
        console.log(`  ${sess.sessionId}  ${sess.status}  ${sess.model}  ${sess.cwd}`);
      }
    }
  } else if (ping) {
    const resp = await sendIpcRequest({ id: 1, method: "ping", params: { target: ping } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as {
      agent: string;
      alive: boolean;
      provider: string;
      activeSessions: number;
      hasActiveSession: boolean;
    };
    console.log(
      `${r.agent}: ${r.alive ? "alive" : "dead"}  provider=${r.provider}  sessions=${r.activeSessions}  active=${r.hasActiveSession}`,
    );
  } else if (stop) {
    const resp = await sendIpcRequest({ id: 1, method: "agent-stop", params: { target: stop } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { agent: string; interrupted: number; totalSessions: number };
    console.log(`[${r.agent}] Interrupted ${r.interrupted}/${r.totalSessions} sessions`);
  } else if (reset) {
    const resp = await sendIpcRequest({ id: 1, method: "agent-reset", params: { target: reset } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { agent: string; reset: number; totalSessions: number };
    console.log(`[${r.agent}] Reset ${r.reset}/${r.totalSessions} sessions`);
  } else if (handoff) {
    const to = args[args.indexOf("--handoff") + 2];
    if (!to) {
      console.error("Usage: arinova-bridge agents --handoff <from> <to>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "handoff", params: { from: handoff, to } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { from: string; to: string; cwd: string; model: string; sessionCount: number };
    console.log(`Handoff: ${r.from} → ${r.to}`);
    console.log(`  CWD: ${r.cwd}`);
    console.log(`  Model: ${r.model}`);
    console.log(`  Sessions transferred context: ${r.sessionCount}`);
  } else if (watch) {
    console.log("Watching agent activity... (Ctrl+C to stop)\n");
    streamWatch((line) => {
      try {
        console.log(renderTaskHistoryRecord(JSON.parse(line) as TaskHistoryRecord));
      } catch {
        // skip ack or malformed lines
      }
    });
    await new Promise(() => {});
  } else if (hasFlag(args, "--history")) {
    const target = history ?? undefined;
    const resp = await sendIpcRequest({ id: 1, method: "history", params: { target, limit: 20 } });
    if ("error" in resp) ipcError(resp);
    const records = resp.result as TaskHistoryRecord[];
    if (records.length === 0) {
      console.log("No task history yet.");
      return;
    }
    for (const r of records) {
      console.log(renderTaskHistoryRecord(r));
    }
  } else if (costAll) {
    const resp = await sendIpcRequest({ id: 1, method: "agent-cost", params: cost ? { target: cost } : {} });
    if ("error" in resp) ipcError(resp);
    if (cost) {
      const c = resp.result as {
        agent: string;
        provider: string;
        totalCostUsd: number;
        inputTokens: number;
        outputTokens: number;
        sessions: number;
      };
      console.log(`Agent: ${c.agent}`);
      console.log(`Cost: $${c.totalCostUsd.toFixed(4)}`);
      console.log(`Tokens: in=${c.inputTokens} out=${c.outputTokens}`);
      console.log(`Sessions: ${c.sessions}`);
    } else {
      const costs = resp.result as Array<{
        agent: string;
        provider: string;
        totalCostUsd: number;
        inputTokens: number;
        outputTokens: number;
        sessions: number;
      }>;
      if (costs.length === 0) {
        console.log("No cost data.");
        return;
      }
      let totalAll = 0;
      for (const c of costs) {
        totalAll += c.totalCostUsd;
        console.log(
          `  ${c.agent}  $${c.totalCostUsd.toFixed(4)}  in=${c.inputTokens} out=${c.outputTokens}  (${c.sessions} sessions)`,
        );
      }
      console.log(`\n  Total: $${totalAll.toFixed(4)}`);
    }
  } else {
    const resp = await sendIpcRequest({ id: 1, method: "list-agents" });
    if ("error" in resp) ipcError(resp);
    const agents = resp.result as Array<{
      name: string;
      provider: string;
      providerDisplayName: string;
      cwd: string;
      model: string;
    }>;
    if (agents.length === 0) {
      console.log("No agents running.");
      return;
    }
    console.log("Running agents:\n");
    for (const a of agents) {
      console.log(`  ${a.name}  ${a.providerDisplayName}  ${a.model}  ${a.cwd}`);
    }
  }
}
