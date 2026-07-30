import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemfsCommands, setMemfsToolsActive } from "../src/commands.js";
import { buildProjection } from "../src/projection.js";
import type { RuntimeState } from "../src/runtime.js";
import { registerMemfsTools } from "../src/tools.js";

export default function localMemfsExtension(pi: ExtensionAPI): void {
  const state: RuntimeState = { enabled: false, agent: "default", config: undefined, store: undefined };

  registerMemfsTools(pi, state);
  registerMemfsCommands(pi, state);

  pi.on("session_start", () => {
    state.enabled = false;
    state.agent = "default";
    state.config = undefined;
    state.store = undefined;
    setMemfsToolsActive(pi, false);
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
