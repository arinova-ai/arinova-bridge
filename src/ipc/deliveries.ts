import { randomUUID } from "node:crypto";

const PAYLOAD_PREVIEW_LIMIT = 100;

/**
 * Wire shape returned by the bridge `snapshot` IPC handler. Field names are
 * snake_case to match the rust-server consumer.
 *
 * `source_agent_id` / `target_agent_id` carry an Arinova agent UUID when the
 * caller supplied one via the IPC `deliver` params, and fall back to the
 * bridge-layer label otherwise: agent name, `spawn:<job-id>`, `fork:<job-id>`,
 * or `cli`. Consumers requiring strict UUIDs join only when the value matches
 * the UUID regex; otherwise treat as a display label.
 */
export interface BridgeDeliveryState {
  delivery_id: string;
  source_agent_id: string;
  target_agent_id: string;
  dispatched_at: string;
  acked_at: string | null;
  payload_preview: string;
}

export interface RegisterDeliveryOpts {
  sourceAgentId: string;
  targetAgentId: string;
  payload: string;
  abortController: AbortController;
}

export type CancelDeliveryResult = "success" | "partial" | "not_found";

interface ActiveDeliveryEntry {
  state: BridgeDeliveryState;
  abortController: AbortController;
}

/**
 * In-process tracker for active A2A deliveries.
 *
 * The bridge is transport-only — this tracker exists purely so the Inspector
 * UI (via rust-server) can snapshot what's currently in flight and best-effort
 * cancel a stuck delivery. It is NOT a durable record: entries vanish on
 * process restart, and successful/cancelled/failed deliveries are removed on
 * completion.
 */
export class BridgeDeliveryTracker {
  private readonly deliveries = new Map<string, ActiveDeliveryEntry>();

  register(opts: RegisterDeliveryOpts): string {
    const delivery_id = randomUUID();
    const dispatched_at = new Date().toISOString();
    const payload_preview = opts.payload.length > PAYLOAD_PREVIEW_LIMIT
      ? opts.payload.slice(0, PAYLOAD_PREVIEW_LIMIT)
      : opts.payload;
    this.deliveries.set(delivery_id, {
      state: {
        delivery_id,
        source_agent_id: opts.sourceAgentId,
        target_agent_id: opts.targetAgentId,
        dispatched_at,
        acked_at: null,
        payload_preview,
      },
      abortController: opts.abortController,
    });
    return delivery_id;
  }

  markAcked(delivery_id: string): void {
    const entry = this.deliveries.get(delivery_id);
    if (entry && entry.state.acked_at === null) {
      entry.state.acked_at = new Date().toISOString();
    }
  }

  complete(delivery_id: string): void {
    this.deliveries.delete(delivery_id);
  }

  /**
   * Best-effort cancel. Returns:
   *   - "not_found": no such delivery (already completed, or never existed)
   *   - "partial":   target had already acked when we got the cancel — the
   *                  abort signal still fires, but the target may already
   *                  be mid-response and we cannot undo that
   *   - "success":   delivery was still unacked; abort fired and entry removed
   */
  cancel(delivery_id: string): CancelDeliveryResult {
    const entry = this.deliveries.get(delivery_id);
    if (!entry) return "not_found";
    const wasAcked = entry.state.acked_at !== null;
    entry.abortController.abort();
    this.deliveries.delete(delivery_id);
    return wasAcked ? "partial" : "success";
  }

  snapshot(): BridgeDeliveryState[] {
    return Array.from(this.deliveries.values()).map((e) => ({ ...e.state }));
  }

  /** Test helper — reset all state. Production code never calls this. */
  reset(): void {
    this.deliveries.clear();
  }
}

/** Process-wide singleton — see {@link BridgeDeliveryTracker}. */
export const activeDeliveries = new BridgeDeliveryTracker();
