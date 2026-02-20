import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import readline from "node:readline";
import type { ThreadEvent } from "./events.js";

export interface CodexSpawnOptions {
  cwd?: string;
  model?: string;
}

export interface CodexProcess {
  child: ChildProcess;
  events: AsyncGenerator<ThreadEvent>;
  stderr: () => string;
}

/** Resolve the Codex binary path: env var → which → error. */
export function resolveCodexBinary(envPath?: string): string {
  if (envPath) {
    return envPath;
  }
  try {
    return execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "Codex binary not found. Install Codex CLI or set CODEX_BINARY_PATH.",
    );
  }
}

/** Spawn `codex exec --json` for a new conversation. */
export function spawnCodexExec(
  codexPath: string,
  prompt: string,
  options: CodexSpawnOptions = {},
): CodexProcess {
  const args = buildExecArgs(prompt, options);
  return spawnCodex(codexPath, args);
}

/** Spawn `codex resume --json` for a follow-up message. */
export function spawnCodexResume(
  codexPath: string,
  threadId: string,
  prompt: string,
  options: CodexSpawnOptions = {},
): CodexProcess {
  const args = buildResumeArgs(threadId, prompt, options);
  return spawnCodex(codexPath, args);
}

/** Send SIGINT to a running Codex child process. */
export function interruptProcess(child: ChildProcess): void {
  if (!child.killed && child.pid) {
    child.kill("SIGINT");
  }
}

/** Wait for a child process to exit and return the exit code. */
export function waitForExit(
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

function buildExecArgs(prompt: string, options: CodexSpawnOptions): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--full-auto",
  ];
  if (options.cwd) {
    args.push("--cd", options.cwd);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push(prompt);
  return args;
}

function buildResumeArgs(
  threadId: string,
  prompt: string,
  options: CodexSpawnOptions,
): string[] {
  const args = [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--full-auto",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push(threadId, prompt);
  return args;
}

function spawnCodex(codexPath: string, args: string[]): CodexProcess {
  const stderrChunks: Buffer[] = [];

  const child = spawn(codexPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
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
): AsyncGenerator<ThreadEvent> {
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
      yield JSON.parse(line) as ThreadEvent;
    } catch {
      // Malformed JSONL line, skip silently
    }
  }
}
