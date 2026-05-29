import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../../../src/util/logger.js";

describe("createLogger", () => {
  it("error method logs to stderr and includes [ERROR] tag", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("test-prefix");

    logger.error("something went wrong");

    expect(errorSpy).toHaveBeenCalledOnce();
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain("[ERROR]");
    expect(line).toContain("[test-prefix]");
    expect(line).toContain("something went wrong");

    errorSpy.mockRestore();
  });
});
