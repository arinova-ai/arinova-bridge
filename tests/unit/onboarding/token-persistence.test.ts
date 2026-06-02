import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config-file.js", () => ({
  readConfigFile: vi.fn(),
  writeConfigFile: vi.fn(),
}));

import { savePermanentToken } from "../../../src/onboarding/token-persistence.js";
import { readConfigFile, writeConfigFile } from "../../../src/config-file.js";

const mockRead = vi.mocked(readConfigFile);
const mockWrite = vi.mocked(writeConfigFile);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("savePermanentToken", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("updates top-level botToken in existing config", () => {
    mockRead.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "wss://api.chat.arinova.ai", botToken: "obt_old" },
      defaultProvider: "anthropic-oauth",
      providers: [],
      defaults: {},
    });

    savePermanentToken("ari_new_permanent", logger);

    expect(mockWrite).toHaveBeenCalledOnce();
    const saved = mockWrite.mock.calls[0][0];
    expect(saved.arinova.botToken).toBe("ari_new_permanent");
  });

  it("updates matching agent entry in multi-agent config", () => {
    mockRead.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "wss://api.chat.arinova.ai", botToken: "obt_old" },
      defaultProvider: "anthropic-oauth",
      providers: [],
      defaults: {},
      agents: [
        { name: "hank", botToken: "obt_old", provider: "anthropic-oauth" },
        { name: "ron", botToken: "ari_ron_token", provider: "anthropic-oauth" },
      ],
    });

    savePermanentToken("ari_new_permanent", logger, "hank");

    const saved = mockWrite.mock.calls[0][0];
    expect(saved.arinova.botToken).toBe("ari_new_permanent");
    expect(saved.agents![0].botToken).toBe("ari_new_permanent");
    expect(saved.agents![1].botToken).toBe("ari_ron_token");
  });

  it("does not modify agents when agentName not provided", () => {
    mockRead.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "wss://api.chat.arinova.ai", botToken: "obt_old" },
      defaultProvider: "anthropic-oauth",
      providers: [],
      defaults: {},
      agents: [{ name: "hank", botToken: "obt_old", provider: "anthropic-oauth" }],
    });

    savePermanentToken("ari_new_permanent", logger);

    const saved = mockWrite.mock.calls[0][0];
    expect(saved.arinova.botToken).toBe("ari_new_permanent");
    expect(saved.agents![0].botToken).toBe("obt_old");
  });

  it("creates minimal config with provider when no config exists", () => {
    mockRead.mockReturnValue(null);

    savePermanentToken("ari_new_permanent", logger);

    const saved = mockWrite.mock.calls[0][0];
    expect(saved.version).toBe(2);
    expect(saved.arinova.botToken).toBe("ari_new_permanent");
    expect(saved.providers).toHaveLength(1);
    expect(saved.providers[0].type).toBe("anthropic-cli");
  });
});
