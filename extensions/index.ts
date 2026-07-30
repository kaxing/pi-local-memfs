import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemfsCommands, setMemfsToolsActive } from "../src/commands.js";
import { resolveConfig } from "../src/config.js";
import { GitMemoryStore } from "../src/git-store.js";
import { buildProjection } from "../src/projection.js";
import type { RuntimeState } from "../src/runtime.js";
import { loadPersistedState } from "../src/state.js";
import { registerMemfsTools } from "../src/tools.js";

export default function localMemfsExtension(pi: ExtensionAPI): void {
  const state: RuntimeState = { enabled: false, agent: "default", config: undefined, store: undefined };

  registerMemfsTools(pi, state);
  registerMemfsCommands(pi, state);

  pi.on("session_start", async (_event, ctx) => {
    state.enabled = false;
    state.config = undefined;
    state.store = undefined;
    setMemfsToolsActive(pi, false);

    try {
      const persisted = await loadPersistedState();
      state.agent = persisted.agent;
      if (!persisted.enabled) return;
      const store = new GitMemoryStore(resolveConfig(persisted.agent));
      await store.initialize(ctx.signal);
      state.config = store.config;
      state.store = store;
      state.enabled = true;
      setMemfsToolsActive(pi, true);
    } catch (error) {
      state.agent = "default";
      const message = `local-memfs could not restore persisted state: ${(error as Error).message}`;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled || !state.store) return;
    const projection = await buildProjection(state.store, ctx.signal);
    return { systemPrompt: `${event.systemPrompt}\n\n${projection}` };
  });

  pi.on("session_shutdown", () => {
    state.enabled = false;
    state.config = undefined;
    state.store = undefined;
  });
}
