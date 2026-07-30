import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersistedState, savePersistedState, statePath } from "../src/state.js";

describe("persisted extension state", () => {
  it("defaults off and round-trips enabled state plus agent selection", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-state-"));
    const env = { PI_LOCAL_MEMFS_HOME: home };
    expect(await loadPersistedState(env)).toEqual({ enabled: false, agent: "default" });

    await savePersistedState({ enabled: true, agent: "work" }, env);
    expect(await loadPersistedState(env)).toEqual({ enabled: true, agent: "work" });
  });

  it("rejects malformed or symlinked state files", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-state-invalid-"));
    const env = { PI_LOCAL_MEMFS_HOME: home };
    await mkdir(home, { recursive: true });
    await writeFile(statePath(env), "{}\n");
    await expect(loadPersistedState(env)).rejects.toThrow(/Invalid/);

    const other = resolve(home, "other.json");
    await writeFile(other, '{"schemaVersion":1,"enabled":true,"agent":"default"}\n');
    await writeFile(statePath(env), "", { flag: "w" });
    const linkedHome = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-state-link-"));
    await symlink(other, statePath({ PI_LOCAL_MEMFS_HOME: linkedHome }));
    await expect(loadPersistedState({ PI_LOCAL_MEMFS_HOME: linkedHome })).rejects.toThrow(/regular file/);
  });
});
