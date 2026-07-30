import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveMemfsHome, validateAgentName } from "./config.js";

export interface PersistedState {
  readonly enabled: boolean;
  readonly agent: string;
}

const DEFAULT_STATE: PersistedState = Object.freeze({ enabled: false, agent: "default" });

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveMemfsHome(env), "state.json");
}

export async function loadPersistedState(env: NodeJS.ProcessEnv = process.env): Promise<PersistedState> {
  const path = statePath(env);
  let raw: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("local-memfs state must be a regular file");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_STATE;
    throw error;
  }

  let parsed: { schemaVersion?: unknown; enabled?: unknown; agent?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("Invalid local-memfs state.json");
  }
  if (parsed.schemaVersion !== 1 || typeof parsed.enabled !== "boolean" || typeof parsed.agent !== "string") {
    throw new Error("Invalid local-memfs state.json");
  }
  return Object.freeze({ enabled: parsed.enabled, agent: validateAgentName(parsed.agent) });
}

export async function savePersistedState(
  state: PersistedState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const agent = validateAgentName(state.agent);
  const path = statePath(env);
  await mkdir(dirname(path), { recursive: true });
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("local-memfs state must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = resolve(dirname(path), `.state.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, enabled: state.enabled, agent }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
