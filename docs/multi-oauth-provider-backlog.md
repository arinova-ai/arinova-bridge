# Multi OAuth Provider Backlog

## Goal

Support multiple OAuth accounts for CLI-backed providers through one consistent provider config field.

Default behavior must stay unchanged:

- `openai-oauth` without `configDir` uses the local Codex account in `~/.codex`.
- `anthropic-oauth` without `configDir` uses the local Claude account in `~/.claude`.

Additional providers can opt into separate accounts:

- `openai-oauth2` with `configDir` maps to `CODEX_HOME`.
- `anthropic-oauth2` with `configDir` maps to `CLAUDE_CONFIG_DIR`.

## Proposed Config

```json
{
  "providers": [
    {
      "id": "openai-oauth",
      "type": "openai-cli",
      "displayName": "Codex Local",
      "enabled": true
    },
    {
      "id": "openai-oauth2",
      "type": "openai-cli",
      "displayName": "Codex Second Account",
      "enabled": true,
      "configDir": "~/.arinova-bridge/accounts/openai-oauth2"
    },
    {
      "id": "anthropic-oauth",
      "type": "anthropic-cli",
      "displayName": "Claude Local",
      "enabled": true
    },
    {
      "id": "anthropic-oauth2",
      "type": "anthropic-cli",
      "displayName": "Claude Second Account",
      "enabled": true,
      "configDir": "~/.arinova-bridge/accounts/anthropic-oauth2"
    }
  ]
}
```

## Implementation Checklist

1. Add `configDir` to provider config.
   - Update `ProviderEntry` in `src/config-file.ts`.
   - Treat it as optional.
   - Expand leading `~` to the user home directory wherever it is used.

2. Add a shared config-dir resolver.
   - Prefer a small helper such as `resolveProviderConfigDir(entry.configDir)`.
   - Keep path normalization in one place so `login`, provider creation, and status checks do not drift.

3. Wire `configDir` for `openai-cli`.
   - Pass `configDir` from `src/providers/registry.ts` into `OpenAICliProvider`.
   - Map provider `configDir` to `CODEX_HOME` when spawning Codex.
   - For providers without `configDir`, keep current default behavior.

4. Fix OpenAI per-agent Codex homes.
   - Current per-agent homes are generated under `~/.arinova-bridge/codex/<provider>/<agent>`.
   - When provider `configDir` exists, per-agent homes should link/copy auth from that provider config dir, not always from `~/.codex`.
   - Keep per-agent MCP isolation, because Arinova bot tokens are agent-specific.

5. Wire `configDir` for `anthropic-cli`.
   - Pass `configDir` from `src/providers/registry.ts` into `AnthropicCliProvider`.
   - Map provider `configDir` to `CLAUDE_CONFIG_DIR` in the provider env.
   - For providers without `configDir`, keep current default behavior.

6. Update `arinova-bridge login`.
   - `arinova-bridge login openai-oauth2` should run Codex login with `CODEX_HOME=<configDir>`.
   - `arinova-bridge login anthropic-oauth2` should run Claude login with `CLAUDE_CONFIG_DIR=<configDir>`.
   - Create `configDir` before spawning the CLI.
   - Continue supporting interactive provider selection.
   - Keep MiniMax OAuth behavior unchanged.

7. Update login status checks.
   - OpenAI status should inspect `<configDir>/auth.json` when `configDir` is set, otherwise `~/.codex/auth.json`.
   - Anthropic status should run `claude auth status` with `CLAUDE_CONFIG_DIR=<configDir>` when set.
   - Gemini remains out of scope.

8. Update docs only.
   - Document `configDir` in CLI help and README.
   - Add examples for `openai-oauth2` and `anthropic-oauth2`.
   - Do not add extra `openai-oauth2` / `anthropic-oauth2` options to the setup wizard.
   - Advanced multi-account providers should be added manually in `config.json`, then authenticated with `arinova-bridge login <provider-id>`.

9. Add focused tests.
   - Config type accepts `configDir`.
   - Registry passes `configDir` into OpenAI/Anthropic providers.
   - `login openai-oauth2` spawns Codex with `CODEX_HOME`.
   - `login anthropic-oauth2` spawns Claude with `CLAUDE_CONFIG_DIR`.
   - OpenAI status reads the configured auth path.
   - Existing providers without `configDir` still use default behavior.

10. Verify.
    - Run `npm test -- --runInBand` if supported by the current test runner; otherwise run focused Vitest files first.
    - Run `npm run build`.
    - Manually smoke-test:

```bash
arinova-bridge login openai-oauth2
arinova-bridge login anthropic-oauth2
arinova-bridge config
```

## Login UX

Target user-facing commands:

```bash
arinova-bridge login openai-oauth2
arinova-bridge login anthropic-oauth2
```

Manual fallback during development:

```bash
CODEX_HOME=~/.arinova-bridge/accounts/openai-oauth2 codex auth login
CLAUDE_CONFIG_DIR=~/.arinova-bridge/accounts/anthropic-oauth2 claude login
```

## Compatibility Notes

- Do not rename existing provider ids.
- Do not require `configDir` for existing users.
- Do not move current `~/.codex` or `~/.claude` data.
- Do not write OpenAI or Claude account tokens into bridge config.
- Keep provider account config separate from per-agent MCP token config.
- Keep the setup wizard focused on the default built-in providers; no extra OAuth2 variants there.
- Do not extend this work to `gemini-cli`. Google Gemini CLI account isolation is not part of the plan.
