/**
 * Extract a human-readable message from an unknown caught value.
 *
 * Prefer this over the inline `err instanceof Error ? err.message : String(err)`
 * pattern so the logic lives in one place.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
