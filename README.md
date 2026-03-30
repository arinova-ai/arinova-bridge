# Arinova Bridge

Multi-provider bridge between [Arinova Chat](https://chat.arinova.ai) and AI coding assistants (Claude, Codex, Gemini).

Connect one or more AI agents to Arinova Chat through a single bridge process. Each agent gets its own provider, session management, and working directory.

## Features

- **Multi-provider** — Claude (CLI + SDK), OpenAI Codex, Gemini CLI
- **Multi-agent** — Run multiple agents in one process, each with independent config
- **MCP support** — Pre-installed Playwright and GitHub MCP servers
- **HUD monitoring** — Real-time context usage, rate limits, and cost tracking
- **Session management** — Automatic idle timeout, resume, and reset

## Requirements

- Node.js 20+
- One or more AI CLI tools installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
- An Arinova Chat bot token (`ari_...`)

## Install

```bash
npm install -g @arinova-ai/arinova-bridge
```

## Quick Start

```bash
# 1. Run the interactive setup wizard
arinova-bridge setup

# 2. Start the bridge
arinova-bridge start
```

The setup wizard will guide you through:
- Connecting to Arinova Chat (bot token)
- Choosing AI providers (Claude, Codex, Gemini)
- Configuring OAuth or API keys
- Enabling rate limit monitoring (optional)

## CLI Commands

| Command | Description |
|---------|-------------|
| `arinova-bridge start` | Start the bridge server |
| `arinova-bridge stop` | Stop the running bridge server |
| `arinova-bridge config` | Show current configuration (secrets masked) |
| `arinova-bridge setup` | Interactive setup wizard |
| `arinova-bridge help` | Show detailed help with config examples |

## Configuration

Config file location: `~/.arinova-bridge/config.json`

### Single Agent (default)

```json
{
  "arinova": {
    "serverUrl": "wss://api.chat.arinova.ai",
    "botToken": "ari_your_token_here",
    "agentName": "default"
  },
  "defaultProvider": "anthropic-oauth",
  "providers": [
    {
      "id": "anthropic-oauth",
      "type": "anthropic-cli",
      "displayName": "Claude (OAuth)",
      "enabled": true
    }
  ],
  "defaults": {
    "cwd": "~/projects",
    "maxSessions": 5,
    "idleTimeoutMs": 600000
  }
}
```

### Multi-Agent

Add an `agents` array to run multiple agents, each with its own bot token, provider, working directory, and model:

```json
{
  "arinova": {
    "serverUrl": "wss://api.chat.arinova.ai"
  },
  "providers": [
    { "id": "anthropic-oauth", "type": "anthropic-cli", "displayName": "Claude", "enabled": true },
    { "id": "openai-oauth", "type": "openai-cli", "displayName": "Codex", "enabled": true }
  ],
  "agents": [
    {
      "name": "lucy",
      "botToken": "ari_lucy_token",
      "provider": "anthropic-oauth",
      "cwd": "~/projects",
      "model": "claude-opus-4-6"
    },
    {
      "name": "pan",
      "botToken": "ari_pan_token",
      "provider": "anthropic-oauth",
      "cwd": "~/projects"
    },
    {
      "name": "codex-agent",
      "botToken": "ari_codex_token",
      "provider": "openai-oauth",
      "cwd": "~/workspace",
      "model": "o3"
    }
  ],
  "defaults": {
    "cwd": "~/projects",
    "maxSessions": 5,
    "idleTimeoutMs": 600000
  }
}
```

Without the `agents` array, the bridge runs in single-agent mode using `arinova.botToken`.

## Providers

| Provider | Type | Auth | CLI Required |
|----------|------|------|-------------|
| Claude (OAuth) | `anthropic-cli` | OAuth (automatic) | `claude` |
| Claude (API Key) | `anthropic-sdk` | API key | — |
| OpenAI Codex | `openai-cli` | OAuth | `codex` |
| Gemini | `gemini-cli` | API key | `gemini` |

## MCP Servers

The bridge automatically pre-installs commonly used MCP servers:

| MCP Server | Package | Condition |
|------------|---------|-----------|
| Playwright | `@playwright/mcp@0.0.68` | Always |
| GitHub | `@modelcontextprotocol/server-github@2025.4.8` | When `GITHUB_TOKEN` is set |

MCP servers are downloaded on first use via `npx` (no additional install needed).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ARINOVA_SERVER_URL` | Override WebSocket server URL |
| `ARINOVA_BOT_TOKEN` | Override bot token (single-agent mode) |
| `ARINOVA_AGENT_NAME` | Override agent name (single-agent mode) |
| `DEFAULT_PROVIDER` | Override default provider ID |
| `DEFAULT_CWD` | Override default working directory |
| `MAX_SESSIONS` | Override max concurrent sessions per provider |
| `MCP_CONFIG_PATH` | Override MCP config file path |
| `DB_PATH` | Override SQLite database path |
| `GITHUB_TOKEN` | Enable GitHub MCP server |

## Development

```bash
git clone <repo-url>
cd arinova-bridge
npm install
npm run dev       # Run with tsx (hot reload)
npm run build     # Compile TypeScript
npm test          # Run tests
```

## License

MIT
