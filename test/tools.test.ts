import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { GitMemoryStore } from "../src/git-store.js";
import type { RuntimeState } from "../src/runtime.js";
import { MEMFS_TOOL_NAMES, registerMemfsTools } from "../src/tools.js";

type ToolDefinition = {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

describe("MemFS tools", () => {
  it("registers the exact surface and keeps body text out of details", async () => {
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool(definition: ToolDefinition) {
        tools.set(definition.name, definition);
      },
    } as unknown as ExtensionAPI;
    const state: RuntimeState = { enabled: false, agent: "default", config: undefined, store: undefined };
    registerMemfsTools(pi, state);
    expect([...tools.keys()]).toEqual([...MEMFS_TOOL_NAMES]);

    await expect(tools.get("memfs_list")!.execute("id", {}, undefined, undefined, {})).rejects.toThrow(/disabled/);

    const home = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-tools-"));
    const store = new GitMemoryStore(resolveConfig("default", { PI_LOCAL_MEMFS_HOME: home }));
    const initial = await store.initialize();
    state.enabled = true;
    state.config = store.config;
    state.store = store;

    const body = "sensitive-memory-body";
    const writeResult = await tools.get("memfs_write")!.execute(
      "id",
      { path: "reference/note.md", content: body, description: "Note", expectedRevision: initial },
      undefined,
      undefined,
      {},
    );
    expect(JSON.stringify(writeResult.details)).not.toContain(body);
    expect(writeResult.details.revision).toMatch(/^[0-9a-f]{40}$/);

    const readResult = await tools.get("memfs_read")!.execute(
      "id",
      { path: "reference/note.md" },
      undefined,
      undefined,
      {},
    );
    expect(readResult.content[0]!.text).toContain(body);
    expect(JSON.stringify(readResult.details)).not.toContain(body);

    const longBody = "x".repeat(60 * 1024);
    const longWrite = await tools.get("memfs_write")!.execute(
      "id",
      {
        path: "reference/long.md",
        content: longBody,
        description: "One long line",
        expectedRevision: writeResult.details.revision,
      },
      undefined,
      undefined,
      {},
    );
    expect(longWrite.details.revision).toMatch(/^[0-9a-f]{40}$/);

    let offset = 0;
    let recovered = "";
    do {
      const page = await tools.get("memfs_read")!.execute(
        "id",
        { path: "reference/long.md", offset, limit: 10_000 },
        undefined,
        undefined,
        {},
      );
      const output = page.content[0]!.text;
      recovered += output.slice(output.indexOf("\n\n") + 2, output.lastIndexOf("\n\nnextOffset:"));
      const nextOffset = page.details.nextOffset as number | null;
      if (nextOffset === null) break;
      expect(nextOffset).toBeGreaterThan(offset);
      offset = nextOffset;
    } while (true);
    expect(recovered).toBe(longBody);
  });
});
