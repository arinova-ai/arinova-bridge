import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendIpcRequest = vi.hoisted(() => vi.fn());
const streamWatch = vi.hoisted(() => vi.fn());

vi.mock("../../src/ipc/client.js", () => ({
  sendIpcRequest,
  streamWatch,
}));

async function importCommands() {
  const [{ cmdAgents }, { cmdSpawn }, { cmdFork }] = await Promise.all([
    import("../../src/cli/commands/agents.js"),
    import("../../src/cli/commands/spawn.js"),
    import("../../src/cli/commands/fork.js"),
  ]);
  return { cmdAgents, cmdSpawn, cmdFork };
}

describe("CLI command smoke tests", () => {
  let stdout: string[];
  let stderr: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    sendIpcRequest.mockReset();
    streamWatch.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("agents list renders running agents", async () => {
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: [{ name: "lucy", provider: "anthropic", providerDisplayName: "Claude", cwd: "/repo", model: "sonnet" }],
    });
    const { cmdAgents } = await importCommands();

    await cmdAgents([]);

    expect(sendIpcRequest).toHaveBeenCalledWith({ id: 1, method: "list-agents" });
    expect(stdout.join("\n")).toContain("Running agents:");
    expect(stdout.join("\n")).toContain("lucy  Claude  sonnet  /repo");
  });

  it("agents deliver renders a waited response", async () => {
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: { agent: "lucy", durationMs: 42, text: "done" } });
    const { cmdAgents } = await importCommands();

    await cmdAgents(["--deliver", "lucy", "--content", "hello", "--cwd", "/repo", "--model", "sonnet"]);

    expect(sendIpcRequest).toHaveBeenCalledWith({
      id: 1,
      method: "deliver",
      params: { target: "lucy", content: "hello", cwd: "/repo", model: "sonnet" },
    });
    expect(stdout.join("\n")).toContain("[lucy] (42ms)\ndone");
  });

  it("agents status renders sessions", async () => {
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: {
        name: "lucy",
        provider: "anthropic",
        providerDisplayName: "Claude",
        cwd: "/repo",
        model: "opus",
        activeSessions: 1,
        sessions: [{ sessionId: "sess-1", status: "ready", model: "opus", cwd: "/repo" }],
      },
    });
    const { cmdAgents } = await importCommands();

    await cmdAgents(["--status", "lucy"]);

    expect(stdout.join("\n")).toContain("Agent: lucy");
    expect(stdout.join("\n")).toContain("sess-1  ready  opus  /repo");
  });

  it("agents ping renders health", async () => {
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: { agent: "lucy", alive: true, provider: "anthropic", activeSessions: 2, hasActiveSession: true },
    });
    const { cmdAgents } = await importCommands();

    await cmdAgents(["--ping", "lucy"]);

    expect(stdout.join("\n")).toContain("lucy: alive  provider=anthropic  sessions=2  active=true");
  });

  it("agents cost renders aggregate costs", async () => {
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: [
        {
          agent: "lucy",
          provider: "anthropic",
          totalCostUsd: 1.23456,
          inputTokens: 100,
          outputTokens: 20,
          sessions: 2,
        },
      ],
    });
    const { cmdAgents } = await importCommands();

    await cmdAgents(["--cost"]);

    expect(stdout.join("\n")).toContain("lucy  $1.2346  in=100 out=20  (2 sessions)");
    expect(stdout.join("\n")).toContain("Total: $1.2346");
  });

  it("agents history renders task records", async () => {
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: [
        {
          agent: "lucy",
          content: "task",
          responsePreview: "answer",
          durationMs: 12,
          costUsd: 0.01,
          model: "sonnet",
          timestamp: 0,
        },
      ],
    });
    const { cmdAgents } = await importCommands();

    await cmdAgents(["--history"]);

    expect(stdout.join("\n")).toContain("lucy (12ms $0.0100) sonnet");
    expect(stdout.join("\n")).toContain("→ task");
    expect(stdout.join("\n")).toContain("← answer");
  });

  it("agents renders IPC errors and exits", async () => {
    sendIpcRequest.mockResolvedValueOnce({ id: 1, error: { message: "boom" } });
    const { cmdAgents } = await importCommands();

    await expect(cmdAgents([])).rejects.toThrow("exit 1");
    expect(stderr.join("\n")).toContain("Error: boom");
  });

  it("spawn add renders created job", async () => {
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: { id: "sp-1", parentAgent: "lucy", targetAgent: "pan", status: "running" },
    });
    const { cmdSpawn } = await importCommands();

    await cmdSpawn(["--agent", "lucy", "--target", "pan", "--context", "build"]);

    expect(sendIpcRequest).toHaveBeenCalledWith({
      id: 1,
      method: "spawn-add",
      params: { parentAgent: "lucy", targetAgent: "pan", context: "build" },
    });
    expect(stdout.join("\n")).toContain("Spawned: sp-1");
  });

  it("spawn list renders empty and populated states", async () => {
    const { cmdSpawn } = await importCommands();
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: [] });
    await cmdSpawn(["list"]);
    expect(stdout.join("\n")).toContain("No spawn jobs.");

    stdout = [];
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: [
        {
          id: "sp-1",
          parentAgent: "lucy",
          targetAgent: "pan",
          status: "completed",
          durationMs: 1000,
          model: null,
          costUsd: 0.25,
          createdAt: 0,
          completedAt: 1,
          contextPreview: "task",
          resultPreview: "done",
        },
      ],
    });
    await cmdSpawn(["list"]);
    expect(stdout.join("\n")).toContain("Spawn Jobs:");
    expect(stdout.join("\n")).toContain("lucy → pan  completed");
    expect(stdout.join("\n")).toContain("Result: done");
  });

  it("spawn logs, result, and cancel render output", async () => {
    const { cmdSpawn } = await importCommands();
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: { id: "sp-1", status: "running", logs: [] } });
    await cmdSpawn(["logs", "--id", "sp-1"]);
    expect(stdout.join("\n")).toContain("Spawn Logs: sp-1");
    expect(stdout.join("\n")).toContain("No logs yet");

    stdout = [];
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: {
        id: "sp-1",
        parentAgent: "lucy",
        targetAgent: "pan",
        status: "completed",
        context: "task",
        result: "done",
        createdAt: 0,
        completedAt: 1,
        durationMs: 1000,
        model: "sonnet",
        costUsd: null,
      },
    });
    await cmdSpawn(["result", "--id", "sp-1"]);
    expect(stdout.join("\n")).toContain("Spawn Job: sp-1");
    expect(stdout.join("\n")).toContain("--- Result ---\ndone");

    stdout = [];
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: { cancelled: true } });
    await cmdSpawn(["cancel", "--id", "sp-1"]);
    expect(stdout.join("\n")).toContain("Cancelled spawn job: sp-1");
  });

  it("fork add renders created job", async () => {
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: { id: "fk-1", parentAgent: "lucy", status: "running" } });
    const { cmdFork } = await importCommands();

    await cmdFork(["--agent", "lucy", "--task", "build"]);

    expect(sendIpcRequest).toHaveBeenCalledWith({
      id: 1,
      method: "fork-add",
      params: { agent: "lucy", task: "build" },
    });
    expect(stdout.join("\n")).toContain("Forked: fk-1");
  });

  it("fork list renders empty and populated states", async () => {
    const { cmdFork } = await importCommands();
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: [] });
    await cmdFork(["list"]);
    expect(stdout.join("\n")).toContain("No fork jobs.");

    stdout = [];
    sendIpcRequest.mockResolvedValueOnce({
      id: 1,
      result: [
        {
          id: "fk-1",
          parentAgent: "lucy",
          status: "completed",
          durationMs: 1000,
          model: null,
          createdAt: 0,
          completedAt: 1,
          taskPreview: "task",
          resultPreview: "done",
        },
      ],
    });
    await cmdFork(["list"]);
    expect(stdout.join("\n")).toContain("Fork Jobs:");
    expect(stdout.join("\n")).toContain("Task: task");
    expect(stdout.join("\n")).toContain("Result: done");
  });

  it("fork cancel renders output", async () => {
    sendIpcRequest.mockResolvedValueOnce({ id: 1, result: { cancelled: true } });
    const { cmdFork } = await importCommands();

    await cmdFork(["cancel", "--id", "fk-1"]);

    expect(stdout.join("\n")).toContain("Cancelled fork job: fk-1");
  });
});
