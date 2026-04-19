import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentSystemPrompt, loadAgentPrompts } from "../../../src/agents/loader.js";

describe("loadAgentPrompts", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-loader-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  const write = (name: string, content: string) => {
    fs.writeFileSync(path.join(tmpDir, name), content, "utf-8");
  };

  it("returns empty prompts when dir is missing", () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.shared).toBe("");
    expect(prompts.sharedGroups).toEqual([]);
    expect(prompts.agents.size).toBe(0);
  });

  it("_shared.md is injected into every agent", () => {
    write("_shared.md", "GLOBAL SHARED");
    write("pan.md", "PAN BODY");
    write("bella.md", "BELLA BODY");

    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.shared).toBe("GLOBAL SHARED");
    expect(prompts.sharedGroups).toEqual([]);

    expect(buildAgentSystemPrompt("pan", prompts)).toBe("GLOBAL SHARED\n\nPAN BODY");
    expect(buildAgentSystemPrompt("bella", prompts)).toBe("GLOBAL SHARED\n\nBELLA BODY");
  });

  it("_shared_<name>.md with block-list include only reaches listed agents", () => {
    write(
      "_shared_eng.md",
      "---\ninclude:\n  - pan\n  - bella\n---\nENG SHARED",
    );
    write("pan.md", "PAN");
    write("bella.md", "BELLA");
    write("adora.md", "ADORA");

    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.sharedGroups).toHaveLength(1);
    expect(prompts.sharedGroups[0]).toEqual({
      name: "_shared_eng",
      include: ["pan", "bella"],
      body: "ENG SHARED",
    });

    expect(buildAgentSystemPrompt("pan", prompts)).toBe("ENG SHARED\n\nPAN");
    expect(buildAgentSystemPrompt("bella", prompts)).toBe("ENG SHARED\n\nBELLA");
    expect(buildAgentSystemPrompt("adora", prompts)).toBe("ADORA");
  });

  it("accepts inline include list", () => {
    write(
      "_shared_ops.md",
      "---\ninclude: [peter, mia]\n---\nOPS SHARED",
    );
    write("peter.md", "PETER");
    write("pan.md", "PAN");

    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.sharedGroups[0]?.include).toEqual(["peter", "mia"]);
    expect(buildAgentSystemPrompt("peter", prompts)).toBe("OPS SHARED\n\nPETER");
    expect(buildAgentSystemPrompt("pan", prompts)).toBe("PAN");
  });

  it("_shared_<name>.md without include is skipped with a warning", () => {
    write("_shared_orphan.md", "---\nrole: whatever\n---\nNOT INJECTED");
    write("pan.md", "PAN");

    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.sharedGroups).toEqual([]);
    expect(buildAgentSystemPrompt("pan", prompts)).toBe("PAN");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("_shared_orphan.md");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("include");
  });

  it("_shared_<name>.md with empty include list is also skipped", () => {
    write("_shared_empty.md", "---\ninclude: []\n---\nNOPE");
    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.sharedGroups).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("combines global shared, matching groups, and per-agent body in order", () => {
    write("_shared.md", "ALL");
    write(
      "_shared_eng.md",
      "---\ninclude:\n  - pan\n---\nENG",
    );
    write(
      "_shared_exec.md",
      "---\ninclude: [pan, lucy]\n---\nEXEC",
    );
    write("pan.md", "PAN");

    const prompts = loadAgentPrompts(tmpDir);
    const pan = buildAgentSystemPrompt("pan", prompts);
    // Groups are sorted alphabetically by filename: _shared_eng before _shared_exec.
    expect(pan).toBe("ALL\n\nENG\n\nEXEC\n\nPAN");
  });

  it("legacy _*.md (non-_shared*) still injects to all agents", () => {
    write("_base.md", "LEGACY BASE");
    write("pan.md", "PAN");

    const prompts = loadAgentPrompts(tmpDir);
    expect(prompts.shared).toBe("LEGACY BASE");
    expect(buildAgentSystemPrompt("pan", prompts)).toBe("LEGACY BASE\n\nPAN");
  });

  it("parses per-agent frontmatter metadata as strings", () => {
    write(
      "pan.md",
      "---\nname: Pan\nrole: engineer\n---\nBODY",
    );
    const prompts = loadAgentPrompts(tmpDir);
    const pan = prompts.agents.get("pan");
    expect(pan?.meta).toEqual({ name: "Pan", role: "engineer" });
    expect(pan?.body).toBe("BODY");
  });

  it("reloading picks up newly added files", () => {
    write("pan.md", "PAN");
    const first = loadAgentPrompts(tmpDir);
    expect(first.sharedGroups).toEqual([]);

    write("_shared_eng.md", "---\ninclude: [pan]\n---\nENG");
    const second = loadAgentPrompts(tmpDir);
    expect(second.sharedGroups).toHaveLength(1);
    expect(buildAgentSystemPrompt("pan", second)).toBe("ENG\n\nPAN");
  });
});
