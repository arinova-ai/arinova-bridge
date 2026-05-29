import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config-file.js";

export interface AgentPrompt {
  /** Frontmatter metadata (name, role, description, etc.) */
  meta: Record<string, string>;
  /** Markdown body — the actual system prompt content */
  body: string;
}

/**
 * A group-shared prompt (`_shared_<groupName>.md`) with an `include` list
 * declaring which agents it applies to.
 */
export interface SharedGroup {
  /** Source file base name, e.g. `_shared_engineering`. */
  name: string;
  /** Agent names this group applies to. Must be non-empty. */
  include: string[];
  /** Markdown body (without frontmatter). */
  body: string;
}

export interface LoadedPrompts {
  /** Concatenated content from files that inject into **every** agent
   *  (i.e. `_shared.md` and any legacy `_*.md` that is not a group file). */
  shared: string;
  /** Group-scoped shared files (`_shared_<name>.md` with an `include` list). */
  sharedGroups: SharedGroup[];
  /** Per-agent prompts, keyed by agent name (filename without `.md`). */
  agents: Map<string, AgentPrompt>;
}

/**
 * Frontmatter parser supporting string values, inline arrays (`key: [a, b]`)
 * and YAML-style block lists:
 *
 *   key:
 *     - a
 *     - b
 */
function parseFrontmatter(raw: string): {
  data: Record<string, string | string[]>;
  content: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw.trim() };

  const data: Record<string, string | string[]> = {};
  const lines = match[1].split(/\r?\n/);

  let currentKey: string | null = null;
  let currentList: string[] = [];

  const commitPendingList = () => {
    if (currentKey !== null) {
      data[currentKey] = currentList;
      currentKey = null;
      currentList = [];
    }
  };

  for (const line of lines) {
    if (currentKey !== null) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        currentList.push(item[1]);
        continue;
      }
      commitPendingList();
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();

    if (value === "") {
      currentKey = key;
      currentList = [];
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      data[key] = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }

    data[key] = value;
  }
  commitPendingList();

  return { data, content: match[2].trim() };
}

function metaToStrings(data: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function extractInclude(data: Record<string, string | string[]>): string[] | null {
  const raw = data.include;
  if (raw === undefined) return null;
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * Load all agent prompt files from `~/.arinova-bridge/agents/`.
 *
 * Shared files (filename starts with `_`):
 *   - `_shared.md` — injected into every agent (no frontmatter required)
 *   - `_shared_<group>.md` — injected only into agents listed in the `include`
 *     frontmatter. Missing or empty `include` → logs a warning and is skipped.
 *   - Other `_*.md` (e.g. `_base.md`) — legacy behaviour, injected into every
 *     agent.
 *
 * Per-agent files:
 *   - `<name>.md` — matched by filename === agent name.
 */
export function loadAgentPrompts(agentsDir?: string): LoadedPrompts {
  const dir = agentsDir ?? path.join(getConfigDir(), "agents");

  if (!fs.existsSync(dir)) {
    return { shared: "", sharedGroups: [], agents: new Map() };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const sharedParts: string[] = [];
  const sharedGroups: SharedGroup[] = [];
  const agents = new Map<string, AgentPrompt>();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    const { data, content } = parseFrontmatter(raw);
    const baseName = file.replace(/\.md$/, "");

    if (!baseName.startsWith("_")) {
      agents.set(baseName, { meta: metaToStrings(data), body: content });
      continue;
    }

    const groupMatch = baseName.match(/^_shared_(.+)$/);
    if (groupMatch) {
      const include = extractInclude(data);
      if (!include) {
        console.warn(
          `[agents] ${file}: missing or empty "include" frontmatter — skipping. ` +
            `Add an include list, e.g.:\n---\ninclude:\n  - pan\n  - bella\n---`,
        );
        continue;
      }
      if (content) {
        sharedGroups.push({ name: baseName, include, body: content });
      }
      continue;
    }

    // `_shared.md` and any other legacy `_*.md` → injected into every agent.
    if (content) sharedParts.push(content);
  }

  return {
    shared: sharedParts.join("\n\n"),
    sharedGroups,
    agents,
  };
}

/**
 * Build the full system prompt for a specific agent.
 * Order: global shared → matching group-shared → agent-specific.
 * Returns empty string if nothing matches.
 */
export function buildAgentSystemPrompt(agentName: string, prompts: LoadedPrompts): string {
  const parts: string[] = [];

  if (prompts.shared) {
    parts.push(prompts.shared);
  }

  for (const group of prompts.sharedGroups) {
    if (group.include.includes(agentName) && group.body) {
      parts.push(group.body);
    }
  }

  const agentPrompt = prompts.agents.get(agentName);
  if (agentPrompt?.body) {
    parts.push(agentPrompt.body);
  }

  return parts.join("\n\n");
}
