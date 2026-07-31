import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../extensions/index.js";
import { MEMFS_TOOL_NAMES } from "../src/tools.js";

const originalHome = process.env.PI_LOCAL_MEMFS_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.PI_LOCAL_MEMFS_HOME;
  else process.env.PI_LOCAL_MEMFS_HOME = originalHome;
});

describe("extension lifecycle", () => {
  it("starts off once, then persists toggle state and the selected agent across sessions", async () => {
    process.env.PI_LOCAL_MEMFS_HOME = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-extension-"));
    const commands = new Map<string, any>();
    const events = new Map<string, any>();
    let active = ["read", "bash"];
    const pi = {
      registerTool(definition: { name: string }) {
        active.push(definition.name);
      },
      registerCommand(name: string, definition: unknown) {
        commands.set(name, definition);
      },
      on(name: string, handler: unknown) {
        events.set(name, handler);
      },
      getActiveTools() {
        return [...active];
      },
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;

    extension(pi);
    expect([...commands.keys()]).toEqual(["local-memfs"]);
    expect(commands.get("local-memfs").getArgumentCompletions("")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
      { value: "agent", label: "agent" },
      { value: "centering", label: "centering" },
    ]);
    await events.get("session_start")({}, {});
    expect(active).toEqual(["read", "bash"]);

    const notices: string[] = [];
    const commandContext = {
      hasUI: true,
      ui: { notify(message: string) { notices.push(message); } },
    };
    await commands.get("local-memfs").handler("on", commandContext);
    expect(active).toEqual(expect.arrayContaining([...MEMFS_TOOL_NAMES]));
    expect(notices.at(-1)).toMatch(/local-memfs on/);
    expect(commands.get("local-memfs").getArgumentCompletions("agent ")).toContainEqual({
      value: "agent default",
      label: "default (selected)",
    });

    await commands.get("local-memfs").handler("agent", commandContext);
    expect(notices.at(-1)).toContain("* default");

    const prompt = await events.get("before_agent_start")(
      { systemPrompt: "base" },
      { signal: undefined },
    );
    expect(prompt.systemPrompt).toContain("<local-memfs>");
    expect(prompt.systemPrompt).toContain("Agent profile: default");

    await commands.get("local-memfs").handler("agent work", commandContext);
    expect(active).toEqual(expect.arrayContaining([...MEMFS_TOOL_NAMES]));
    const switchedPrompt = await events.get("before_agent_start")(
      { systemPrompt: "base" },
      { signal: undefined },
    );
    expect(switchedPrompt.systemPrompt).toContain("Agent profile: work");
    expect(notices.at(-1)).toMatch(/agent 'work' active/);

    await events.get("session_start")({}, {});
    expect(active).toEqual(expect.arrayContaining([...MEMFS_TOOL_NAMES]));
    const restoredPrompt = await events.get("before_agent_start")(
      { systemPrompt: "base" },
      { signal: undefined },
    );
    expect(restoredPrompt.systemPrompt).toContain("Agent profile: work");

    await commands.get("local-memfs").handler("off", commandContext);
    await events.get("session_start")({}, {});
    expect(active).toEqual(["read", "bash"]);
    expect(await events.get("before_agent_start")({ systemPrompt: "base" }, { signal: undefined })).toBeUndefined();
    await commands.get("local-memfs").handler("", commandContext);
    expect(notices.at(-1)).toContain("agent=work");
  });
});
