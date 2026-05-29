/**
 * Shared formatting utilities — extracted from duplicated patterns across
 * handler.ts, cli.ts, router.ts and index.ts.
 */

/** Human-friendly "Xd Yh Zm" countdown from a reset-at epoch. */
export function formatResetIn(epoch: number): string {
  const epochMs = epoch < 1e12 ? epoch * 1000 : epoch;
  const diff = epochMs - Date.now();
  if (diff <= 0) return "now";
  const totalMins = Math.ceil(diff / 60_000);
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

/** Map a job status string to its emoji icon. */
export function getStatusIcon(status: string): string {
  return status === "running" ? "🔄" : status === "completed" ? "✅" : status === "failed" ? "❌" : "⏸️";
}

/** Format a millisecond duration as e.g. "12s", or "—" when absent. */
export function formatDuration(durationMs?: number | null): string {
  return durationMs ? `${Math.round(durationMs / 1000)}s` : "—";
}

/**
 * Format a timestamp for display.
 * @param timestamp  epoch-ms number or ISO string
 * @param timeZone   IANA time zone (default "Asia/Taipei")
 */
export function formatDateTime(timestamp: number | string, timeZone: string = "Asia/Taipei"): string {
  return new Date(timestamp).toLocaleString("zh-TW", { timeZone });
}

/**
 * Truncate a string to `maxLen` characters, appending `suffix` when truncated.
 * Returns the original string unchanged when it fits within `maxLen`.
 */
export function truncate(text: string, maxLen: number, suffix: string = "…"): string {
  return text.length > maxLen ? text.slice(0, maxLen) + suffix : text;
}
