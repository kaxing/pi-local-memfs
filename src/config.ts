import { homedir } from "node:os";
import { resolve } from "node:path";

export const LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxDescriptionBytes: 1024,
  maxSystemBytes: 32 * 1024,
  maxManifestBytes: 16 * 1024,
  maxListEntries: 200,
  maxSearchMatches: 50,
  maxPathLength: 240,
});

export interface MemfsConfig {
  readonly agent: string;
  readonly home: string;
  readonly root: string;
}

export function validateAgentName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("Agent name must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  }
  return name;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export function resolveMemfsHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.PI_LOCAL_MEMFS_HOME?.trim() || "~/.pi/agent/local-memfs");
}

export function resolveConfig(agent: string, env: NodeJS.ProcessEnv = process.env): MemfsConfig {
  const safeAgent = validateAgentName(agent);
  const home = resolveMemfsHome(env);
  return Object.freeze({
    agent: safeAgent,
    home,
    root: resolve(home, "agents", safeAgent),
  });
}
