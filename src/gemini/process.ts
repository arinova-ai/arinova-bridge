import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import readline from "node:readline";
import type { GeminiEvent } from "./events.js";

export interface GeminiSpawnOptions {
  cwd?: string;
  model?: string;
  env?: Record<string, string>;
}

export interface GeminiProcess {
  child: ChildProcess;
  events: AsyncGenerator<GeminiEvent>;
  stderr: () => string;
}

/** Resolve the Gemini binary path: env var → which → error. */
export function resolveGeminiBinary(envPath?: string): string {
  if (envPath) {
    return envPath;
  }
  try {
    return execSync("which gemini", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "Gemini binary not found. Install Gemini CLI or set geminiPath in config.",
    );
  }
}

/** Spawn `gemini -p` for a new conversation. */
export function spawnGeminiExec(
  geminiPath: string,
  prompt: string,
  options: GeminiSpawnOptions = {},
): GeminiProcess {
  const args = buildExecArgs(prompt, options);
  return spawnGemini(geminiPath, args, options.cwd, options.env);
}

/** Spawn `gemini -p --resume` for a follow-up message. */
export function spawnGeminiResume(
  geminiPath: string,
  sessionId: string,
  prompt: string,
  options: GeminiSpawnOptions = {},
): GeminiProcess {
  const args = buildResumeArgs(sessionId, prompt, options);
  return spawnGemini(geminiPath, args, options.cwd, options.env);
}

/** Send SIGINT to a running Gemini child process. */
export function interruptGeminiProcess(child: ChildProcess): void {
  if (!child.killed && child.pid) {
    child.kill("SIGINT");
  }
}

/** Wait for a child process to exit and return the exit code. */
export function waitForGeminiExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function buildExecArgs(prompt: string, options: GeminiSpawnOptions): string[] {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--yolo",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  return args;
}

function buildResumeArgs(
  sessionId: string,
  prompt: string,
  options: GeminiSpawnOptions,
): string[] {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--yolo",
    "--resume", sessionId,
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  return args;
}

function spawnGemini(
  geminiPath: string,
  args: string[],
  cwd?: string,
  customEnv?: Record<string, string>,
): GeminiProcess {
  const stderrChunks: Buffer[] = [];

  const env = customEnv ? { ...process.env, ...customEnv } : undefined;

  const child = spawn(geminiPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env,
  });

  child.stdin?.end();

  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  }

  const events = createEventStream(child);

  return {
    child,
    events,
    stderr: () => Buffer.concat(stderrChunks).toString("utf-8"),
  };
}

async function* createEventStream(
  child: ChildProcess,
): AsyncGenerator<GeminiEvent> {
  if (!child.stdout) {
    return;
  }

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as GeminiEvent;
    } catch {
      // Malformed JSONL line, skip silently
    }
  }
}
