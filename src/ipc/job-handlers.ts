import type { ActiveAgent, IpcResponse } from "./types.js";
import type { IpcHandlerContext } from "./router.js";
import { truncate } from "../util/formatting.js";
import { getErrorMessage } from "../util/errors.js";

function findAgent(agents: ActiveAgent[], name: string): ActiveAgent | undefined {
  return agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

function agentNotFound(id: number, name: string, agents: ActiveAgent[]): IpcResponse {
  const names = agents.map((a) => a.name).join(", ");
  return { id, error: { code: 1, message: `Agent "${name}" not found. Available: ${names}` } };
}

export function handleSpawnAdd(
  id: number,
  params: { parentAgent: string; targetAgent: string; context: string; model?: string; cwd?: string },
  ctx: IpcHandlerContext,
): IpcResponse {
  const { spawnManager } = ctx;
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const parent = findAgent(ctx.agents, params.parentAgent);
  if (!parent) return agentNotFound(id, params.parentAgent, ctx.agents);

  const target = findAgent(ctx.agents, params.targetAgent);
  if (!target) return agentNotFound(id, params.targetAgent, ctx.agents);

  try {
    const job = spawnManager.spawn({
      parentAgent: parent.name,
      targetAgent: target.name,
      context: params.context,
      model: params.model,
      cwd: params.cwd,
    });
    return {
      id,
      result: {
        id: job.id,
        parentAgent: job.parentAgent,
        targetAgent: job.targetAgent,
        status: job.status,
        createdAt: job.createdAt,
      },
    };
  } catch (err) {
    return { id, error: { code: 10, message: getErrorMessage(err) } };
  }
}

export function handleSpawnList(id: number, params: { agent?: string }, ctx: IpcHandlerContext): IpcResponse {
  const { spawnManager } = ctx;
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const jobs = params.agent ? spawnManager.listByParent(params.agent) : spawnManager.listAll();

  return {
    id,
    result: jobs.map((j) => ({
      id: j.id,
      parentAgent: j.parentAgent,
      targetAgent: j.targetAgent,
      status: j.status,
      durationMs: j.durationMs,
      model: j.model,
      costUsd: j.costUsd,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      contextPreview: truncate(j.context, 100),
      resultPreview: j.result
        ? (() => {
            const firstLine = j.result.split("\n")[0];
            const truncated = firstLine.length < j.result.length || firstLine.length > 100;
            const preview = firstLine.slice(0, 100);
            return truncated ? preview + `… (${j.result.length} chars, use spawn result ${j.id})` : preview;
          })()
        : null,
    })),
  };
}

export function handleSpawnCancel(id: number, params: { id: string }, ctx: IpcHandlerContext): IpcResponse {
  const { spawnManager } = ctx;
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const cancelled = spawnManager.cancel(params.id);
  if (!cancelled) {
    return { id, error: { code: 11, message: `Spawn job "${params.id}" not found or already completed` } };
  }
  return { id, result: { cancelled: true, id: params.id } };
}

export function handleSpawnResult(id: number, params: { id: string }, ctx: IpcHandlerContext): IpcResponse {
  const { spawnManager } = ctx;
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const job = spawnManager.getJob(params.id);
  if (!job) {
    return { id, error: { code: 11, message: `Spawn job "${params.id}" not found` } };
  }

  return {
    id,
    result: {
      id: job.id,
      parentAgent: job.parentAgent,
      targetAgent: job.targetAgent,
      status: job.status,
      context: job.context,
      result: job.result,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      durationMs: job.durationMs,
      model: job.model,
      costUsd: job.costUsd,
    },
  };
}

export function handleSpawnLogs(id: number, params: { id: string }, ctx: IpcHandlerContext): IpcResponse {
  const { spawnManager } = ctx;
  if (!spawnManager) return { id, error: { code: 5, message: "Spawn manager not enabled" } };

  const job = spawnManager.getJob(params.id);
  if (!job) {
    return { id, error: { code: 11, message: `Spawn job "${params.id}" not found` } };
  }

  const logs = spawnManager.getLogs(params.id);
  return {
    id,
    result: {
      id: job.id,
      status: job.status,
      logs: logs.map((l) => ({ content: l.content, createdAt: l.createdAt })),
    },
  };
}

export function handleForkAdd(
  id: number,
  params: { agent: string; task: string; model?: string; cwd?: string },
  ctx: IpcHandlerContext,
): IpcResponse {
  const { forkManager } = ctx;
  if (!forkManager) return { id, error: { code: 5, message: "Fork manager not enabled" } };

  const agent = findAgent(ctx.agents, params.agent);
  if (!agent) return agentNotFound(id, params.agent, ctx.agents);

  try {
    const job = forkManager.fork({
      parentAgent: agent.name,
      task: params.task,
      model: params.model,
      cwd: params.cwd,
    });
    return {
      id,
      result: {
        id: job.id,
        parentAgent: job.parentAgent,
        status: job.status,
        createdAt: job.createdAt,
      },
    };
  } catch (err) {
    return { id, error: { code: 12, message: getErrorMessage(err) } };
  }
}

export function handleForkList(id: number, params: { agent?: string }, ctx: IpcHandlerContext): IpcResponse {
  const { forkManager } = ctx;
  if (!forkManager) return { id, error: { code: 5, message: "Fork manager not enabled" } };

  let jobs;
  if (params.agent) {
    const agent = findAgent(ctx.agents, params.agent);
    if (!agent) return agentNotFound(id, params.agent, ctx.agents);
    jobs = forkManager.listByParent(agent.name);
  } else {
    jobs = forkManager.listAll();
  }

  return {
    id,
    result: jobs.map((j) => ({
      id: j.id,
      parentAgent: j.parentAgent,
      status: j.status,
      durationMs: j.durationMs,
      model: j.model,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      taskPreview: truncate(j.task, 100),
      resultPreview: j.result ? truncate(j.result, 100) : null,
    })),
  };
}

export function handleForkCancel(id: number, params: { id: string }, ctx: IpcHandlerContext): IpcResponse {
  const { forkManager } = ctx;
  if (!forkManager) return { id, error: { code: 5, message: "Fork manager not enabled" } };

  const cancelled = forkManager.cancel(params.id);
  if (!cancelled) {
    return { id, error: { code: 13, message: `Fork job "${params.id}" not found or already completed` } };
  }
  return { id, result: { cancelled: true, id: params.id } };
}
