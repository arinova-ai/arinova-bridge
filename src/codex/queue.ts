import type { ChildProcess } from "node:child_process";

/**
 * Per-conversation task queue.
 * Ensures only one Codex process runs per conversation at a time.
 */
export class ConversationQueue {
  private queues = new Map<string, Array<() => Promise<void>>>();
  private running = new Set<string>();

  /** Active child processes, keyed by conv_id. */
  readonly activeProcesses = new Map<string, ChildProcess>();

  async enqueue(convId: string, task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wrapped = async () => {
        try {
          await task();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      if (!this.queues.has(convId)) {
        this.queues.set(convId, []);
      }
      this.queues.get(convId)!.push(wrapped);

      if (!this.running.has(convId)) {
        this.drain(convId);
      }
    });
  }

  private async drain(convId: string): Promise<void> {
    this.running.add(convId);
    const queue = this.queues.get(convId)!;

    while (queue.length > 0) {
      const task = queue.shift()!;
      await task();
    }

    this.running.delete(convId);
    this.queues.delete(convId);
  }
}
