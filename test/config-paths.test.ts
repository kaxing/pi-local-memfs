import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig, validateAgentName } from "../src/config.js";
import { assertNoSymlinkSegments, normalizeMemoryPath, resolveMemoryPath } from "../src/paths.js";

describe("configuration and paths", () => {
  it("resolves isolated global agent profiles", () => {
    const home = resolve(tmpdir(), "memfs-home");
    expect(resolveConfig("default", { PI_LOCAL_MEMFS_HOME: home }).root).toBe(resolve(home, "agents", "default"));
    expect(resolveConfig("work_2", { PI_LOCAL_MEMFS_HOME: home }).root).toBe(resolve(home, "agents", "work_2"));
    expect(() => validateAgentName("../escape")).toThrow();
    expect(() => validateAgentName("Upper")).toThrow();
  });

  it("accepts safe Markdown paths and a leading @", () => {
    expect(normalizeMemoryPath("@system/persona.md")).toBe("system/persona.md");
    expect(normalizeMemoryPath("reference/日本語.md")).toBe("reference/日本語.md");
    expect(resolveMemoryPath("/tmp/root", "notes/a.md").absolute).toBe("/tmp/root/notes/a.md");
  });

  it.each([
    "../escape.md",
    "/absolute.md",
    "C:/absolute.md",
    "a\\b.md",
    "a//b.md",
    "a/./b.md",
    "a/../b.md",
    "notes.txt",
    ".git/config.md",
    ".GIT/config.md",
    ".MemFS/config.md",
    "SKILLS/demo/SKILL.md",
    ".memfs/config.md",
    "skills/demo/SKILL.md",
    "reference/bad\nname.md",
  ])("rejects unsafe path %s", (path) => {
    expect(() => normalizeMemoryPath(path)).toThrow();
  });

  it("rejects a symlink in an existing path", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "memfs-paths-"));
    await mkdir(resolve(root, "outside"));
    await symlink(resolve(root, "outside"), resolve(root, "reference"));
    await expect(assertNoSymlinkSegments(root, "reference/file.md")).rejects.toThrow(/symlink/);
  });
});
