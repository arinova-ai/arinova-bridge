export type JobReportStatus = "completed" | "failed";

export function clearTrackedTimeout(id: string, timers: Map<string, ReturnType<typeof setTimeout>>): boolean {
  const timer = timers.get(id);
  if (!timer) return false;
  clearTimeout(timer);
  timers.delete(id);
  return true;
}

export function clearTrackedInterval(id: string, timers: Map<string, ReturnType<typeof setInterval>>): boolean {
  const timer = timers.get(id);
  if (!timer) return false;
  clearInterval(timer);
  timers.delete(id);
  return true;
}

export function buildJobReportContent(opts: {
  kind: "spawn" | "fork";
  id: string;
  status: JobReportStatus;
  result: string;
  targetAgent?: string;
}): string {
  const statusLabel = opts.status === "completed" ? "完成" : "失敗";
  const preview = opts.result.length > 2000 ? opts.result.slice(0, 2000) + "\n...(truncated)" : opts.result;
  const prefix =
    opts.kind === "spawn" && opts.targetAgent
      ? `[spawn:${opts.id} from:${opts.targetAgent}]`
      : `[${opts.kind}:${opts.id}]`;
  return `${prefix} ${statusLabel}\n${preview}`;
}
