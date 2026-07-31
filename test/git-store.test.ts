import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { DEFAULT_PERSONA_BODY, GitMemoryStore } from "../src/git-store.js";

async function makeStore(agent = "test") {
  const home = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-"));
  const store = new GitMemoryStore(resolveConfig(agent, { PI_LOCAL_MEMFS_HOME: home }));
  return { store, home };
}

describe("GitMemoryStore", () => {
  beforeEach(() => {
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });

  it("seeds and restores a minimal Pi-compatible persona during initialization", async () => {
    const { store } = await makeStore();
    const initial = await store.initialize();
    const persona = await store.read("system/persona.md");
    expect(persona.body).toBe(DEFAULT_PERSONA_BODY);
    expect(persona.description).toMatch(/Minimal identity/);

    const deleted = await store.delete("system/persona.md", initial);
    const restored = await store.initialize();
    expect(restored).not.toBe(deleted.revision);
    expect((await store.read("system/persona.md")).body).toBe(DEFAULT_PERSONA_BODY);

    const legacyBody = `I am a Pi coding agent with durable local memory.
I preserve only stable preferences, decisions, and lessons that improve future work.
I keep memory concise, never store secrets, and treat the user's current request and Pi's instructions as authoritative.`;
    const legacy = await store.write("system/persona.md", legacyBody, undefined, restored);
    const migrated = await store.initialize();
    expect(migrated).not.toBe(legacy.revision);
    expect((await store.read("system/persona.md")).body).toBe(DEFAULT_PERSONA_BODY);
  });

  it("initializes idempotently and creates one commit per mutation", async () => {
    const { store } = await makeStore();
    const initial = await store.initialize();
    expect(await store.initialize()).toBe(initial);

    const written = await store.write("system/persona.md", "I am local.", "Agent identity", initial);
    expect(written.changed).toBe(true);
    expect(written.revision).not.toBe(initial);

    const snapshot = await store.snapshot();
    expect(snapshot.revision).toBe(written.revision);
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ path: "system/persona.md", description: "Agent identity", body: "I am local." }),
    ]);

    const noChange = await store.edit("system/persona.md", "local", "local", written.revision);
    expect(noChange).toMatchObject({ changed: false, revision: written.revision });

    const edited = await store.edit("system/persona.md", "local", "durable", written.revision);
    expect((await store.read("system/persona.md")).body).toBe("I am durable.");

    const moved = await store.move("system/persona.md", "system/identity.md", edited.revision);
    expect((await store.read("system/identity.md")).body).toBe("I am durable.");
    const deleted = await store.delete("system/identity.md", moved.revision);
    expect(await store.snapshot()).toMatchObject({ revision: deleted.revision, entries: [] });
    expect((await store.history(undefined, 10)).length).toBe(5);
  });

  it("reads committed HEAD and refuses model writes while manual edits are dirty", async () => {
    const { store } = await makeStore();
    const initial = await store.initialize();
    const written = await store.write("reference/note.md", "committed", "A note", initial);
    const absolute = resolve(store.config.root, "reference/note.md");
    await writeFile(absolute, `---\ndescription: A note\n---\n\ndirty`, "utf8");

    expect((await store.read("reference/note.md")).body).toBe("committed");
    await expect(store.write("reference/other.md", "body", "Other", written.revision)).rejects.toThrow(/uncommitted/);

    const manual = await store.commitManualChanges("Manual update");
    expect(manual.changed).toBe(true);
    expect((await store.read("reference/note.md")).body).toBe("dirty");
  });

  it("serializes concurrent writers and rejects the stale loser", async () => {
    const { store } = await makeStore();
    const second = new GitMemoryStore(store.config);
    const initial = await store.initialize();
    const results = await Promise.allSettled([
      store.write("reference/a.md", "A", "A", initial),
      second.write("reference/b.md", "B", "B", initial),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await store.snapshot()).entries).toHaveLength(2);
    expect((await store.status()).dirty).toBe(false);
  });

  it("rolls back an invalid model mutation and leaves HEAD clean", async () => {
    const { store } = await makeStore();
    const initial = await store.initialize();
    await expect(
      store.write("system/oversized.md", "x".repeat(32 * 1024 + 1), "Too large", initial),
    ).rejects.toThrow(/system\/ memory exceeds/);
    expect(await store.head()).toBe(initial);
    expect(await store.snapshot()).toMatchObject({
      revision: initial,
      entries: [expect.objectContaining({ path: "system/persona.md" })],
    });
    expect((await store.status()).dirty).toBe(false);
  });

  it("validates manual edits without staging invalid files", async () => {
    const { store } = await makeStore();
    await store.initialize();
    await writeFile(resolve(store.config.root, "bad.txt"), "bad", "utf8");
    await expect(store.commitManualChanges("bad")).rejects.toThrow(/\.md extension/);
    expect(await readFile(resolve(store.config.root, "bad.txt"), "utf8")).toBe("bad");
    expect((await store.status()).dirty).toBe(true);
  });

  it("does not allow manual deletion of repository identity", async () => {
    const { store } = await makeStore();
    await store.initialize();
    await rm(resolve(store.config.root, ".memfs/config.json"));
    await expect(store.commitManualChanges("delete config")).rejects.toThrow(/Missing \.memfs\/config/);
    expect((await store.status()).dirty).toBe(true);
  });

  it("searches committed path, description, and body literally", async () => {
    const { store } = await makeStore();
    const initial = await store.initialize();
    await store.write("reference/project.md", "Alpha needle\nBeta", "Project facts", initial);
    const matches = await store.search("needle");
    expect(matches).toEqual([expect.objectContaining({ path: "reference/project.md", line: 1 })]);
  });

  it("rejects a symlink profile root before initialization", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-root-link-"));
    const outside = await mkdtemp(resolve(tmpdir(), "pi-local-memfs-outside-"));
    await mkdir(resolve(home, "agents"), { recursive: true });
    await symlink(outside, resolve(home, "agents/default"));
    const store = new GitMemoryStore(resolveConfig("default", { PI_LOCAL_MEMFS_HOME: home }));
    await expect(store.initialize()).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("forces SHA-1 repositories even when Git defaults to SHA-256", async () => {
    const previous = process.env.GIT_DEFAULT_HASH;
    process.env.GIT_DEFAULT_HASH = "sha256";
    try {
      const { store } = await makeStore("sha1");
      expect(await store.initialize()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      if (previous === undefined) delete process.env.GIT_DEFAULT_HASH;
      else process.env.GIT_DEFAULT_HASH = previous;
    }
  });

  it("rejects moving a directory whose name ends in .md without deleting ignored data", async () => {
    const { store } = await makeStore();
    const initial = await store.initialize();
    const written = await store.write("bundle.md/item.md", "item", "Nested item", initial);
    const ignored = resolve(store.config.root, "bundle.md/local-cache");
    await writeFile(resolve(store.config.root, ".git/info/exclude"), "bundle.md/local-cache\n", { flag: "a" });
    await writeFile(ignored, "keep me");

    await expect(store.move("bundle.md", "other.md", written.revision)).rejects.toThrow(/regular file/);
    expect((await store.read("bundle.md/item.md")).body).toBe("item");
    expect(await readFile(ignored, "utf8")).toBe("keep me");
    expect((await store.status()).dirty).toBe(false);
  });
});
