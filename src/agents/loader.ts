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
 * Simple frontmatter parser.
 * Splits `---\nkey: value\n---\nbody` into { data, content }.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, content: raw.trim() };

  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { data, content: match[2].trim() };
}

/**
 * Load all agent prompt files from `~/.arinova-bridge/agents/`.
 *
 * Convention:
 *  - `_*.md` files are **shared** prompts injected into every agent (sorted by filename).
 *  - Other `*.md` files are **per-agent** prompts, matched by filename === agent name.
 *
 * Returns a map: agentName → assembled system prompt string.
 * The shared prefix is also available via the `_shared` key.
 */
export function loadAgentPrompts(): {
  shared: string;
  agents: Map<string, AgentPrompt>;
} {
  const agentsDir = path.join(getConfigDir(), "agents");

  if (!fs.existsSync(agentsDir)) {
    return { shared: "", agents: new Map() };
  }

  const files = fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const sharedParts: string[] = [];
  const agents = new Map<string, AgentPrompt>();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(agentsDir, file), "utf-8");
    const { data, content } = parseFrontmatter(raw);
    const baseName = file.replace(/\.md$/, "");

    if (baseName.startsWith("_")) {
      // Shared prompt — injected into all agents
      if (content) sharedParts.push(content);
    } else {
      // Per-agent prompt
      agents.set(baseName, { meta: data, body: content });
    }
  }

  return {
    shared: sharedParts.join("\n\n"),
    agents,
  };
}

/**
 * Build the full system prompt for a specific agent.
 * Returns `shared + agent-specific`, or empty string if neither exists.
 */
export function buildAgentSystemPrompt(
  agentName: string,
  prompts: { shared: string; agents: Map<string, AgentPrompt> },
): string {
  const parts: string[] = [];

  if (prompts.shared) {
    parts.push(prompts.shared);
  }

  const agentPrompt = prompts.agents.get(agentName);
  if (agentPrompt?.body) {
    parts.push(agentPrompt.body);
  }

  return parts.join("\n\n");
}
