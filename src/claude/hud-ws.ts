export type HudData = {
  context?: { used: number; total: number; percent: number };
  limit5h?: { percent: number; resetIn: string };
  limit7d?: { percent: number; resetIn: string };
  model?: string;
};

export type TaskData =
  | { status: "started"; task: string }
  | { status: "completed"; durationMs?: number; costUsd?: number; numTurns?: number };

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-5-20250514": "Sonnet 4.5",
  "claude-opus-4-20250514": "Opus 4",
};

export function formatModelName(modelId: string): string {
  return MODEL_NAMES[modelId] ?? modelId;
}
