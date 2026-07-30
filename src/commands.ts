import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig, validateAgentName } from "./config.js";
import { GitMemoryStore } from "./git-store.js";
import type { RuntimeState } from "./runtime.js";
import { savePersistedState } from "./state.js";
import { MEMFS_TOOL_NAMES } from "./tools.js";

function report(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

export function setMemfsToolsActive(pi: ExtensionAPI, enabled: boolean): void {
  const owned = new Set<string>(MEMFS_TOOL_NAMES);
  const current = pi.getActiveTools().filter((name) => !owned.has(name));
  pi.setActiveTools(enabled ? [...new Set([...current, ...MEMFS_TOOL_NAMES])] : current);
}

function createStore(agent: string): GitMemoryStore {
  return new GitMemoryStore(resolveConfig(agent));
}

async function enable(pi: ExtensionAPI, state: RuntimeState): Promise<string> {
  const store = createStore(state.agent);
  const revision = await store.initialize();
  await savePersistedState({ enabled: true, agent: state.agent });
  state.config = store.config;
  state.store = store;
  state.enabled = true;
  setMemfsToolsActive(pi, true);
  return revision;
}

async function disable(pi: ExtensionAPI, state: RuntimeState): Promise<void> {
  await savePersistedState({ enabled: false, agent: state.agent });
  state.enabled = false;
  state.config = undefined;
  state.store = undefined;
  setMemfsToolsActive(pi, false);
}

export function registerMemfsCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("toggle-local-memfs", {
    description: "Toggle local-memfs or select an agent profile: [on|off|status|agent <name>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "toggle";
      try {
        if (action === "agent") {
          const name = parts[1];
          if (!name || parts.length !== 2) throw new Error("Usage: /toggle-local-memfs agent <name>");
          validateAgentName(name);
          if (state.enabled) {
            const store = createStore(name);
            const revision = await store.initialize();
            await savePersistedState({ enabled: true, agent: name });
            state.agent = name;
            state.config = store.config;
            state.store = store;
            report(ctx, `local-memfs agent '${name}' active at ${revision.slice(0, 8)}`);
          } else {
            await savePersistedState({ enabled: false, agent: name });
            state.agent = name;
            report(ctx, `local-memfs agent set to '${name}' (layer remains off)`);
          }
          return;
        }

        if (action === "status") {
          const store = state.store ?? createStore(state.agent);
          const status = await store.status();
          report(
            ctx,
            `local-memfs ${state.enabled ? "on" : "off"}; agent=${state.agent}; revision=${status.revision?.slice(0, 8) ?? "uninitialized"}; dirty=${status.dirty}; root=${status.root}`,
            status.dirty ? "warning" : "info",
          );
          return;
        }

        if (action === "off" || (action === "toggle" && state.enabled)) {
          await disable(pi, state);
          report(ctx, `local-memfs off; agent '${state.agent}' data and history preserved`);
          return;
        }
        if (action === "on" || (action === "toggle" && !state.enabled)) {
          const revision = await enable(pi, state);
          report(ctx, `local-memfs on; agent='${state.agent}'; revision=${revision.slice(0, 8)}`);
          return;
        }
        throw new Error("Usage: /toggle-local-memfs [on|off|status|agent <name>]");
      } catch (error) {
        report(ctx, (error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("memfs-init", {
    description: "Initialize the selected local-memfs agent repository without enabling the layer",
    handler: async (_args, ctx) => {
      try {
        const store = createStore(state.agent);
        const revision = await store.initialize();
        report(ctx, `Initialized local-memfs agent '${state.agent}' at ${revision.slice(0, 8)}`);
      } catch (error) {
        report(ctx, (error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("memfs-status", {
    description: "Show selected local-memfs agent status",
    handler: async (_args, ctx) => {
      try {
        const status = await (state.store ?? createStore(state.agent)).status();
        report(
          ctx,
          `agent=${state.agent}\nenabled=${state.enabled}\nroot=${status.root}\nrevision=${status.revision ?? "uninitialized"}\ndirty=${status.dirty}`,
          status.dirty ? "warning" : "info",
        );
      } catch (error) {
        report(ctx, (error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("memfs-commit", {
    description: "Validate and commit manual edits in the selected local-memfs repository",
    handler: async (args, ctx) => {
      try {
        const store = state.store ?? createStore(state.agent);
        const result = await store.commitManualChanges(args.trim() || "Update local-memfs");
        report(ctx, result.changed ? `Committed ${result.revision}` : `No manual changes; HEAD ${result.revision}`);
      } catch (error) {
        report(ctx, (error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("memfs-log", {
    description: "Show recent commits for the selected local-memfs repository",
    handler: async (args, ctx) => {
      try {
        const parsedLimit = Number.parseInt(args.trim(), 10);
        const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
        const history = await (state.store ?? createStore(state.agent)).history(undefined, limit);
        report(
          ctx,
          history.map((item) => `${item.revision.slice(0, 8)} ${item.timestamp} ${item.message}`).join("\n") || "No commits",
        );
      } catch (error) {
        report(ctx, (error as Error).message, "error");
      }
    },
  });
}
