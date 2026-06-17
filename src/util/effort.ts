// Unified, provider-agnostic effort/reasoning level.
//
// Config exposes ONE `effort` field (per-agent, overriding `defaults.effort`).
// It accepts a number 1-5 or a level name. Internally everything is mapped onto
// a single ascending scale; each provider then clamps to the range IT supports,
// so a value too high for a provider degrades to that provider's maximum rather
// than erroring.
//
//   numeric:           1       2        3       4        5
//   scale:   minimal   low     medium   high    xhigh    max
//   claude (--effort):         low     medium   high    xhigh    max   (1..5)
//   codex  (turn effort):      low     medium   high    xhigh          (1..4, clamps 5→xhigh)
//
// `minimal` has no number and sits below 1. It is reachable only by the string
// "minimal", and both providers clamp it up to "low": claude has no minimal
// level, and (verified against codex 0.139.0) no current codex model advertises
// "minimal" — sending it fails the turn with a 400. Current codex models DO
// advertise "xhigh", so codex's ceiling is xhigh (not high); only "max" clamps.

export const EFFORT_SCALE = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_SCALE)[number];

// Numeric 1-5 maps onto the claude-canonical levels (no number for "minimal").
const NUMERIC_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Inclusive [min, max] rank each provider supports, as indices into EFFORT_SCALE.
const PROVIDER_RANGE: Record<string, readonly [number, number]> = {
  "anthropic-cli": [1, 5], // low .. max
  "openai-cli": [1, 4], //    low .. xhigh ("minimal" is rejected by current codex models)
};

/**
 * Parse a raw config effort value (number/numeric-string 1-5, or a level name)
 * into a canonical level. Returns null for unset/empty or anything invalid —
 * callers that need to reject invalid input use {@link validateEffort}.
 */
export function parseEffort(value: unknown): EffortLevel | null {
  if (value === undefined || value === null || value === "") return null;
  const str = String(value).trim().toLowerCase();
  if (/^[0-9]+$/.test(str)) {
    const n = Number(str);
    return n >= 1 && n <= 5 ? NUMERIC_LEVELS[n - 1] : null;
  }
  return (EFFORT_SCALE as readonly string[]).includes(str) ? (str as EffortLevel) : null;
}

/**
 * Validate a config effort value at load time. Returns the canonical level, or
 * undefined when unset. Throws a helpful error on an invalid value so a typo in
 * config.json fails fast instead of being silently ignored.
 */
export function validateEffort(value: unknown, name = "effort"): EffortLevel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const level = parseEffort(value);
  if (!level) {
    throw new Error(
      `${name} must be a number 1-5 or one of ${EFFORT_SCALE.join("/")} (got ${JSON.stringify(value)})`,
    );
  }
  return level;
}

/**
 * Resolve an effort value to the string a given provider accepts, clamping to
 * that provider's supported range. Returns undefined when unset or
 * unparseable (so an unknown value never blocks a send — it just omits effort).
 */
export function resolveEffortForProvider(value: unknown, providerType: string): string | undefined {
  const level = parseEffort(value);
  if (!level) return undefined;
  const range = PROVIDER_RANGE[providerType];
  if (!range) return level; // unknown provider: pass the canonical level through
  const rank = EFFORT_SCALE.indexOf(level);
  const clamped = Math.min(Math.max(rank, range[0]), range[1]);
  return EFFORT_SCALE[clamped];
}
