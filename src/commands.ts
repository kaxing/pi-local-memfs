import { type Dirent, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig, resolveMemfsHome, validateAgentName } from "./config.js";
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

function agentNames(entries: Dirent[]): string[] {
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      try {
        validateAgentName(entry.name);
        return true;
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();
}

const CENTERING_PROMPT = `The user invoked /local-memfs centering and explicitly requests a synchronous memory maintenance pass.

Review only the recent conversation visible in your current context and the active committed local MemFS profile. Do not claim access to conversations that are not present.

Proceed conservatively:
1. Inspect existing memory before changing it. Read only files relevant to candidate updates.
2. Prioritize user corrections, explicitly durable preferences, stable decisions or facts, and contradictions with existing memory.
3. Skip one-off task details, temporary state, information already captured, unsupported inferences, secrets, credentials, PII, and host-specific details.
4. Audit relevant memory for duplication, stale contradictions, inaccurate descriptions, poor system-versus-external placement, and unnecessary system-prompt bloat.
5. Preserve persona and behavioral identity. Make surgical changes rather than rewriting files wholesale.
6. Use only the local MemFS tools for memory mutations. Each mutation must use the latest revision returned by the preceding operation.
7. Making no changes is valid when nothing clearly durable or structurally useful needs attention.

Finish with a concise report of what you reviewed, files changed, skipped candidates, and resulting revisions.`;

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
  pi.registerCommand("local-memfs", {
    description: "Manage local-memfs: [on|off|agent [name]|centering]",
    getArgumentCompletions: (prefix) => {
      const agentMatch = /^agent\s+(.*)$/.exec(prefix);
      if (agentMatch) {
        let agents: string[];
        try {
          agents = agentNames(readdirSync(resolve(resolveMemfsHome(), "agents"), { withFileTypes: true }));
        } catch {
          return null;
        }
        const namePrefix = agentMatch[1]!;
        const matches = agents
          .filter((name) => name.startsWith(namePrefix))
          .map((name) => ({ value: `agent ${name}`, label: name === state.agent ? `${name} (selected)` : name }));
        return matches.length > 0 ? matches : null;
      }

      const options = ["on", "off", "agent", "centering"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return options.length > 0 ? options : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      try {
        if (action === "agent") {
          const name = parts[1];
          if (!name) {
            if (parts.length !== 1) throw new Error("Usage: /local-memfs agent [name]");
            let entries: Dirent[];
            try {
              entries = await readdir(resolve(resolveMemfsHome(), "agents"), { withFileTypes: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              entries = [];
            }
            const agents = agentNames(entries);
            report(
              ctx,
              agents.length > 0
                ? `local-memfs agents (selected=${state.agent}):\n${agents.map((agent) => `${agent === state.agent ? "*" : " "} ${agent}`).join("\n")}`
                : `No initialized local-memfs agents (selected=${state.agent})`,
            );
            return;
          }
          if (parts.length !== 2) throw new Error("Usage: /local-memfs agent [name]");
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

        if (action === "on" && parts.length === 1) {
          const revision = await enable(pi, state);
          report(ctx, `local-memfs on; agent='${state.agent}'; revision=${revision.slice(0, 8)}`);
          return;
        }
        if (action === "off" && parts.length === 1) {
          await disable(pi, state);
          report(ctx, `local-memfs off; agent '${state.agent}' data and history preserved`);
          return;
        }
        if (action === "status" && parts.length === 0) {
          const status = await (state.store ?? createStore(state.agent)).status();
          report(
            ctx,
            `agent=${state.agent}\nenabled=${state.enabled}\nroot=${status.root}\nrevision=${status.revision ?? "uninitialized"}\ndirty=${status.dirty}`,
            status.dirty ? "warning" : "info",
          );
          return;
        }
        if (action === "centering" && parts.length === 1) {
          if (!state.enabled) {
            report(ctx, "local-memfs is disabled; run /local-memfs on first", "warning");
            return;
          }
          pi.sendUserMessage(CENTERING_PROMPT);
          return;
        }
        throw new Error("Usage: /local-memfs [on|off|agent [name]|centering]");
      } catch (error) {
        report(ctx, (error as Error).message, "error");
      }
    },
  });
}
