import type { CommandContext } from "./types.js";
import type { SpawnManager } from "../spawn/manager.js";
import type { ForkManager } from "../fork/manager.js";
import { formatDateTime, formatDuration, getStatusIcon, truncate } from "../util/formatting.js";
import { getErrorMessage } from "../util/errors.js";

type Reply = (ctx: CommandContext, text: string) => void;

export function handleSpawnCommand(opts: {
  arg: string;
  ctx: CommandContext;
  spawnManager?: SpawnManager;
  agentName?: string;
  reply: Reply;
}): void {
  const { arg, ctx, spawnManager, agentName, reply } = opts;
  if (!spawnManager || !agentName) {
    reply(ctx, "Spawn manager 未啟用");
    return;
  }

  const parts = arg.split(/\s+/);
  const sub = parts[0]?.toLowerCase();

  if (!sub || sub === "help") {
    reply(
      ctx,
      [
        "用法:",
        "  /spawn list — 列出所有 spawn 子任務",
        "  /spawn result <id> — 查看完整回傳內容",
        "  /spawn logs <id> — 查看執行過程 log",
        "  /spawn cancel <id> — 取消 spawn 子任務",
        "",
        "Spawn 透過 CLI 建立：",
        "  arinova-bridge spawn --agent <parent> --target <target> --context '...'",
      ].join("\n"),
    );
    return;
  }

  switch (sub) {
    case "list":
    case "ls":
      handleSpawnList(ctx, spawnManager, agentName, reply);
      return;
    case "result":
      handleSpawnResult(parts.slice(1), ctx, spawnManager, agentName, reply);
      return;
    case "logs":
    case "log":
      handleSpawnLogs(parts.slice(1), ctx, spawnManager, agentName, reply);
      return;
    case "cancel":
      handleSpawnCancel(parts.slice(1), ctx, spawnManager, reply);
      return;
    default:
      reply(ctx, `未知的 spawn 子指令: ${sub}\n用法: /spawn list|result|logs|cancel`);
  }
}

function handleSpawnList(ctx: CommandContext, spawnManager: SpawnManager, agentName: string, reply: Reply): void {
  const jobs = spawnManager.listByParent(agentName);

  if (jobs.length === 0) {
    reply(ctx, "目前沒有 spawn 子任務");
    return;
  }

  const lines = ["Spawn Jobs:\n"];
  for (const job of jobs) {
    const statusIcon = getStatusIcon(job.status);
    const duration = formatDuration(job.durationMs);
    const time = formatDateTime(job.createdAt);
    lines.push(`${statusIcon} \`${job.id}\`  → ${job.targetAgent}  ${job.status}  ${duration}`);
    lines.push(`   ${time}  ${truncate(job.context, 60)}`);
    if (job.result) {
      const firstLine = job.result.split("\n")[0].slice(0, 80);
      const truncated = job.result.length > 80;
      lines.push(`   Result: ${firstLine}${truncated ? `… (/spawn result ${job.id})` : ""}`);
    }
  }

  reply(ctx, lines.join("\n"));
}

function handleSpawnResult(
  parts: string[],
  ctx: CommandContext,
  spawnManager: SpawnManager,
  agentName: string,
  reply: Reply,
): void {
  const jobId = parts[0];
  if (!jobId) {
    reply(ctx, "用法: /spawn result <id>");
    return;
  }

  const job = spawnManager.getJob(jobId);
  if (!job || job.parentAgent !== agentName) {
    reply(ctx, `找不到 spawn job "${jobId}"`);
    return;
  }

  const statusIcon = getStatusIcon(job.status);
  const duration = formatDuration(job.durationMs);
  const time = formatDateTime(job.createdAt);

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

  reply(ctx, lines.join("\n"));
}

function handleSpawnLogs(
  parts: string[],
  ctx: CommandContext,
  spawnManager: SpawnManager,
  agentName: string,
  reply: Reply,
): void {
  const jobId = parts[0];
  if (!jobId) {
    reply(ctx, "用法: /spawn logs <id>");
    return;
  }

  const job = spawnManager.getJob(jobId);
  if (!job || job.parentAgent !== agentName) {
    reply(ctx, `找不到 spawn job "${jobId}"`);
    return;
  }

  const logs = spawnManager.getLogs(jobId);
  const statusIcon = getStatusIcon(job.status);

  if (logs.length === 0) {
    const hint = job.status === "running" ? "（尚無 log — 任務仍在執行中）" : "（無 log 紀錄）";
    reply(ctx, `${statusIcon} Spawn Logs: \`${job.id}\`  ${job.status}\n\n${hint}`);
    return;
  }

  const lines = [`${statusIcon} Spawn Logs: \`${job.id}\`  ${job.status}\n`];
  for (const entry of logs) {
    const time = formatDateTime(entry.createdAt);
    lines.push(`**[${time}]**`);
    lines.push(entry.content);
  }

  reply(ctx, lines.join("\n"));
}

function handleSpawnCancel(parts: string[], ctx: CommandContext, spawnManager: SpawnManager, reply: Reply): void {
  const target = parts[0];
  if (!target) {
    reply(ctx, "用法: /spawn cancel <id>");
    return;
  }

  const cancelled = spawnManager.cancel(target);
  if (cancelled) {
    reply(ctx, `已取消 spawn job \`${target}\``);
  } else {
    reply(ctx, `找不到或無法取消 spawn job "${target}"（可能已完成）`);
  }
}

export function handleForkCommand(opts: {
  arg: string;
  ctx: CommandContext;
  forkManager?: ForkManager;
  agentName?: string;
  reply: Reply;
}): void {
  const { arg, ctx, forkManager, agentName, reply } = opts;
  if (!forkManager || !agentName) {
    reply(ctx, "Fork manager 未啟用");
    return;
  }

  const parts = arg.split(/\s+/);
  const sub = parts[0]?.toLowerCase();

  if (!sub || sub === "help") {
    reply(
      ctx,
      [
        "用法:",
        "  /fork <task> — Fork 分身執行任務",
        "  /fork list — 列出所有 fork 任務",
        "  /fork cancel <id> — 取消 fork 任務",
        "",
        "也可透過 CLI 建立：",
        "  arinova-bridge fork --agent <name> --task '...'",
      ].join("\n"),
    );
    return;
  }

  switch (sub) {
    case "list":
    case "ls":
      handleForkList(ctx, forkManager, agentName, reply);
      return;
    case "cancel":
      handleForkCancel(parts.slice(1), ctx, forkManager, reply);
      return;
    default:
      handleForkCreate(arg, ctx, forkManager, agentName, reply);
  }
}

function handleForkCreate(
  task: string,
  ctx: CommandContext,
  forkManager: ForkManager,
  agentName: string,
  reply: Reply,
): void {
  try {
    const job = forkManager.fork({
      parentAgent: agentName,
      task,
    });
    reply(ctx, `已建立 fork \`${job.id}\`\n任務: ${truncate(task, 100)}\n\n分身正在背景執行，完成後會自動回報結果。`);
  } catch (err) {
    reply(ctx, `Fork 建立失敗: ${getErrorMessage(err)}`);
  }
}

function handleForkList(ctx: CommandContext, forkManager: ForkManager, agentName: string, reply: Reply): void {
  const jobs = forkManager.listByParent(agentName);

  if (jobs.length === 0) {
    reply(ctx, "目前沒有 fork 任務");
    return;
  }

  const lines = ["Fork Jobs:\n"];
  for (const job of jobs) {
    const statusIcon = getStatusIcon(job.status);
    const duration = formatDuration(job.durationMs);
    const time = formatDateTime(job.createdAt);
    lines.push(`${statusIcon} \`${job.id}\`  ${job.status}  ${duration}`);
    lines.push(`   ${time}  ${truncate(job.task, 60)}`);
  }

  reply(ctx, lines.join("\n"));
}

function handleForkCancel(parts: string[], ctx: CommandContext, forkManager: ForkManager, reply: Reply): void {
  const target = parts[0];
  if (!target) {
    reply(ctx, "用法: /fork cancel <id>");
    return;
  }

  const cancelled = forkManager.cancel(target);
  if (cancelled) {
    reply(ctx, `已取消 fork job \`${target}\``);
  } else {
    reply(ctx, `找不到或無法取消 fork job "${target}"（可能已完成）`);
  }
}
