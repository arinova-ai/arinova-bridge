import { formatDateTime, formatDuration, getStatusIcon } from "../util/formatting.js";

export interface TaskHistoryRecord {
  agent: string;
  content: string;
  responsePreview: string;
  durationMs: number;
  costUsd?: number;
  model?: string;
  timestamp: number;
}

export interface SpawnListRecord {
  id: string;
  parentAgent: string;
  targetAgent: string;
  status: string;
  durationMs: number | null;
  model: string | null;
  costUsd: number | null;
  createdAt: number;
  completedAt: number | null;
  contextPreview: string;
  resultPreview: string | null;
}

export interface ForkListRecord {
  id: string;
  parentAgent: string;
  status: string;
  durationMs: number | null;
  model: string | null;
  createdAt: number;
  completedAt: number | null;
  taskPreview: string;
  resultPreview: string | null;
}

export interface SpawnResultRecord {
  id: string;
  parentAgent: string;
  targetAgent: string;
  status: string;
  context: string;
  result: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  model: string | null;
  costUsd: number | null;
}

export interface SpawnLogsRecord {
  id: string;
  status: string;
  logs: Array<{ content: string; createdAt: number }>;
}

export function renderTaskHistoryRecord(r: TaskHistoryRecord): string {
  const time = new Date(r.timestamp).toLocaleTimeString();
  const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(4)}` : "";
  return `[${time}] ${r.agent} (${r.durationMs}ms${cost}) ${r.model ?? ""}\n  → ${r.content}\n  ← ${r.responsePreview}\n`;
}

export function renderSpawnLogs(data: SpawnLogsRecord): string {
  const lines = [`${getStatusIcon(data.status)} Spawn Logs: ${data.id}  (${data.status})`, ""];
  if (data.logs.length === 0) {
    lines.push(data.status === "running" ? "(No logs yet — job is still running)" : "(No logs recorded)");
  } else {
    for (const entry of data.logs) {
      lines.push(`[${formatDateTime(entry.createdAt)}]`, entry.content);
    }
  }
  return lines.join("\n");
}

export function renderSpawnResult(job: SpawnResultRecord): string {
  const statusIcon = getStatusIcon(job.status);
  const duration = formatDuration(job.durationMs);
  const cost = job.costUsd != null ? `$${job.costUsd.toFixed(4)}` : "—";
  const time = formatDateTime(job.createdAt);
  const lines = [
    `${statusIcon} Spawn Job: ${job.id}`,
    `  Parent: ${job.parentAgent}  Target: ${job.targetAgent}`,
    `  Status: ${job.status}  Duration: ${duration}  Cost: ${cost}`,
    `  Created: ${time}`,
  ];
  if (job.model) lines.push(`  Model: ${job.model}`);
  lines.push(`\n--- Context ---\n${job.context}`);
  if (job.result) {
    lines.push(`\n--- Result ---\n${job.result}`);
  } else if (job.status === "running") {
    lines.push("\n(Job is still running — no result yet)");
  } else {
    lines.push("\n(No result)");
  }
  return lines.join("\n");
}

export function renderSpawnList(jobs: SpawnListRecord[]): string {
  if (jobs.length === 0) return "No spawn jobs.";
  const lines = ["Spawn Jobs:", ""];
  for (const job of jobs) {
    const statusIcon = getStatusIcon(job.status);
    const duration = formatDuration(job.durationMs);
    const cost = job.costUsd != null ? ` $${job.costUsd.toFixed(4)}` : "";
    lines.push(`  ${statusIcon} ${job.id}  ${job.parentAgent} → ${job.targetAgent}  ${job.status}  ${duration}${cost}`);
    lines.push(`     Context: ${job.contextPreview}`);
    if (job.resultPreview) {
      lines.push(`     Result: ${job.resultPreview}`);
    } else if (job.status === "running") {
      lines.push("     Result: (running…)");
    }
  }
  return lines.join("\n");
}

export function renderForkList(jobs: ForkListRecord[]): string {
  if (jobs.length === 0) return "No fork jobs.";
  const lines = ["Fork Jobs:", ""];
  for (const job of jobs) {
    const statusIcon = getStatusIcon(job.status);
    const duration = formatDuration(job.durationMs);
    lines.push(`  ${statusIcon} ${job.id}  ${job.parentAgent}  ${job.status}  ${duration}`);
    lines.push(`     Task: ${job.taskPreview}`);
    if (job.resultPreview) {
      lines.push(`     Result: ${job.resultPreview}`);
    }
  }
  return lines.join("\n");
}
