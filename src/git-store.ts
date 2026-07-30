import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { MemfsConfig } from "./config.js";
import { LIMITS } from "./config.js";
import { parseMemoryDocument, serializeMemoryDocument } from "./frontmatter.js";
import { withRepositoryLock } from "./lock.js";
import { assertNoSymlinkSegments, isSystemPath, normalizeMemoryPath, resolveMemoryPath } from "./paths.js";
import { renderSystemSection } from "./projection.js";

export const DEFAULT_PERSONA_BODY = `I am a Pi coding agent with durable local memory.
I preserve only stable preferences, decisions, and lessons that improve future work.
I keep memory concise, never store secrets, and treat the user's current request and Pi's instructions as authoritative.`;

const DEFAULT_PERSONA_DESCRIPTION = "Minimal identity and durable-memory guidance for this Pi agent";

export interface MemoryEntry {
  readonly path: string;
  readonly description: string;
  readonly body: string;
  readonly size: number;
}

export interface Snapshot {
  readonly revision: string;
  readonly entries: readonly MemoryEntry[];
}

export interface StoreStatus {
  readonly initialized: boolean;
  readonly revision: string | null;
  readonly dirty: boolean;
  readonly root: string;
  readonly agent: string;
}

export interface MutationResult {
  readonly operation: string;
  readonly paths: readonly string[];
  readonly priorRevision: string;
  readonly revision: string;
  readonly changed: boolean;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

interface RunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly allowFailure?: boolean | undefined;
}

async function run(command: string, args: readonly string[], cwd: string, options: RunOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const maxBytes = 16 * 1024 * 1024;

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0 || options.allowFailure) return resolvePromise(out);
      const message = Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = resolve(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function cleanMessage(message: string, fallback: string): string {
  const cleaned = message.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  return cleaned || fallback;
}

export class GitMemoryStore {
  readonly config: MemfsConfig;

  constructor(config: MemfsConfig) {
    this.config = config;
  }

  private git(args: readonly string[], options: RunOptions = {}): Promise<string> {
    return run("git", args, this.config.root, options);
  }

  private async isInitialized(): Promise<boolean> {
    return pathExists(resolve(this.config.root, ".git"));
  }

  async initialize(signal?: AbortSignal): Promise<string> {
    return withRepositoryLock(this.config.root, async () => {
      if (await this.isInitialized()) {
        const revision = await this.requireHead(signal);
        await this.validateRepositoryIdentity(revision, signal);
        const paths = await this.trackedMarkdownPaths(revision, signal);
        if (paths.includes("system/persona.md")) return revision;

        const dirty = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], { signal });
        if (dirty) throw new Error("Cannot seed system/persona.md while the memory repository has uncommitted changes");
        const personaPath = resolve(this.config.root, "system", "persona.md");
        if (await pathExists(personaPath)) {
          throw new Error("Cannot seed system/persona.md because an ignored filesystem entry already exists there");
        }
        let personaWritten = false;
        try {
          await assertNoSymlinkSegments(this.config.root, "system/persona.md");
          await atomicWrite(
            personaPath,
            serializeMemoryDocument(DEFAULT_PERSONA_BODY, { description: DEFAULT_PERSONA_DESCRIPTION }),
          );
          personaWritten = true;
          await this.validateWorkingTree();
          await this.git(["add", "--", "system/persona.md"], { signal });
          await this.git(["commit", "-m", "Seed minimal persona"], { signal });
          return await this.requireHead(signal);
        } catch (error) {
          if (personaWritten) await rm(personaPath, { force: true });
          await this.git(["reset", "--hard", revision], { allowFailure: true });
          throw error;
        }
      }

      const entries = await readdir(this.config.root);
      if (entries.length > 0) throw new Error(`Cannot initialize non-empty directory: ${this.config.root}`);

      try {
        await run("git", ["--version"], this.config.root, { signal });
      } catch {
        throw new Error("git CLI is required for local-memfs");
      }

      try {
        await this.git(["init", "--object-format=sha1", "-b", "main"], { signal });
        await this.git(["config", "user.name", "pi-local-memfs"], { signal });
        await this.git(["config", "user.email", "pi-local-memfs@local"], { signal });
        const configPath = resolve(this.config.root, ".memfs", "config.json");
        await atomicWrite(
          configPath,
          `${JSON.stringify({ schemaVersion: 1, agent: this.config.agent }, null, 2)}\n`,
        );
        const personaPath = resolve(this.config.root, "system", "persona.md");
        await atomicWrite(
          personaPath,
          serializeMemoryDocument(DEFAULT_PERSONA_BODY, { description: DEFAULT_PERSONA_DESCRIPTION }),
        );
        await this.git(["add", "--", ".memfs/config.json", "system/persona.md"], { signal });
        await this.git(["commit", "-m", "Initialize local-memfs"], { signal });
        return await this.requireHead(signal);
      } catch (error) {
        await rm(this.config.root, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async head(signal?: AbortSignal): Promise<string | null> {
    if (!(await this.isInitialized())) return null;
    const out = await this.git(["rev-parse", "HEAD"], { signal, allowFailure: true });
    const head = out.trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  }

  private async requireHead(signal?: AbortSignal): Promise<string> {
    const head = await this.head(signal);
    if (!head) throw new Error("local-memfs is not initialized");
    return head;
  }

  private async validateRepositoryIdentity(revision: string, signal?: AbortSignal): Promise<void> {
    let raw: string;
    try {
      raw = await this.git(["show", `${revision}:.memfs/config.json`], { signal });
    } catch {
      throw new Error("Not a local-memfs repository: missing committed .memfs/config.json");
    }
    let parsed: { schemaVersion?: unknown; agent?: unknown };
    try {
      parsed = JSON.parse(raw) as { schemaVersion?: unknown; agent?: unknown };
    } catch {
      throw new Error("Not a local-memfs repository: invalid committed configuration");
    }
    if (parsed.schemaVersion !== 1 || parsed.agent !== this.config.agent) {
      throw new Error("local-memfs repository configuration does not match the selected agent");
    }
  }

  async status(signal?: AbortSignal): Promise<StoreStatus> {
    const revision = await this.head(signal);
    if (!revision) {
      return { initialized: false, revision: null, dirty: false, root: this.config.root, agent: this.config.agent };
    }
    const porcelain = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], { signal });
    return {
      initialized: true,
      revision,
      dirty: porcelain.length > 0,
      root: this.config.root,
      agent: this.config.agent,
    };
  }

  private async trackedMarkdownPaths(ref: string, signal?: AbortSignal): Promise<string[]> {
    const out = await this.git(["ls-tree", "-r", "-z", ref], { signal });
    const paths: string[] = [];
    for (const record of out.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(" ");
      const rawPath = record.slice(tab + 1);
      if (meta[0] === "120000") continue;
      try {
        paths.push(normalizeMemoryPath(rawPath));
      } catch {
        // Internal and reserved files are not part of the memory projection.
      }
    }
    return paths.sort((a, b) => {
      const aParts = a.split("/");
      const bParts = b.split("/");
      const length = Math.min(aParts.length, bParts.length);
      for (let index = 0; index < length; index++) {
        if (aParts[index] === bParts[index]) continue;
        const aDirectory = index < aParts.length - 1;
        const bDirectory = index < bParts.length - 1;
        if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
        return aParts[index]!.localeCompare(bParts[index]!);
      }
      return aParts.length - bParts.length;
    });
  }

  async snapshot(ref?: string, signal?: AbortSignal): Promise<Snapshot> {
    const revision = ref ?? (await this.requireHead(signal));
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Snapshot revision must be a full Git SHA");
    await this.validateRepositoryIdentity(revision, signal);
    const paths = await this.trackedMarkdownPaths(revision, signal);
    const entries: MemoryEntry[] = [];
    for (const path of paths) {
      const content = await this.git(["show", `${revision}:${path}`], { signal });
      const document = parseMemoryDocument(content);
      entries.push({
        path,
        description: document.description,
        body: document.body,
        size: Buffer.byteLength(content, "utf8"),
      });
    }
    return { revision, entries };
  }

  async read(path: string, ref?: string, signal?: AbortSignal): Promise<MemoryEntry> {
    const logical = normalizeMemoryPath(path);
    const snapshot = await this.snapshot(ref, signal);
    const entry = snapshot.entries.find((candidate) => candidate.path === logical);
    if (!entry) throw new Error(`Memory file not found: ${logical}`);
    return entry;
  }

  async search(query: string, pathPrefix = "", ref?: string, signal?: AbortSignal): Promise<SearchMatch[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new Error("Search query must not be empty");
    const prefix = pathPrefix ? pathPrefix.replace(/^@/, "").replace(/\/+$/, "") : "";
    if (prefix && (prefix.includes("\\") || prefix.split("/").some((part) => !part || part === "." || part === ".."))) {
      throw new Error("Invalid search path prefix");
    }

    const snapshot = await this.snapshot(ref, signal);
    const matches: SearchMatch[] = [];
    for (const entry of snapshot.entries) {
      if (prefix && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) continue;
      const pathText = `${entry.path}\n${entry.description}`.toLocaleLowerCase();
      if (pathText.includes(needle)) {
        matches.push({ path: entry.path, line: 0, snippet: entry.description || entry.path });
        if (matches.length >= LIMITS.maxSearchMatches) return matches;
      }
      for (const [index, line] of entry.body.split("\n").entries()) {
        if (line.toLocaleLowerCase().includes(needle)) {
          matches.push({ path: entry.path, line: index + 1, snippet: line.slice(0, 300) });
        }
        if (matches.length >= LIMITS.maxSearchMatches) return matches;
      }
    }
    return matches;
  }

  async history(path?: string, limit = 20, signal?: AbortSignal): Promise<Array<{
    revision: string;
    parent: string | null;
    author: string;
    timestamp: string;
    message: string;
  }>> {
    await this.requireHead(signal);
    const args = ["log", `-n${Math.max(1, Math.min(limit, 100))}`, "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e"];
    if (path) args.push("--", normalizeMemoryPath(path));
    const out = await this.git(args, { signal });
    return out
      .split("\x1e")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [revision = "", parents = "", author = "", timestamp = "", message = ""] = record.split("\x1f");
        return { revision, parent: parents.split(" ")[0] || null, author, timestamp, message };
      });
  }

  async write(
    path: string,
    body: string,
    description: string | undefined,
    expectedRevision: string,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const target = resolveMemoryPath(this.config.root, path);
    return this.mutate("write", [target.logical], expectedRevision, signal, async () => {
      await assertNoSymlinkSegments(this.config.root, target.logical);
      const exists = await pathExists(target.absolute);
      const existing = exists ? await readFile(target.absolute, "utf8") : undefined;
      const content = serializeMemoryDocument(body, { existing, description });
      if (existing === content) return false;
      await atomicWrite(target.absolute, content);
      return true;
    });
  }

  async edit(
    path: string,
    oldText: string,
    newText: string,
    expectedRevision: string,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    if (!oldText) throw new Error("oldText must not be empty");
    const target = resolveMemoryPath(this.config.root, path);
    return this.mutate("edit", [target.logical], expectedRevision, signal, async () => {
      await assertNoSymlinkSegments(this.config.root, target.logical);
      const content = await readFile(target.absolute, "utf8");
      const document = parseMemoryDocument(content);
      const count = document.body.split(oldText).length - 1;
      if (count !== 1) throw new Error(`oldText must match exactly once; found ${count} matches`);
      const body = document.body.replace(oldText, newText);
      const next = serializeMemoryDocument(body, { existing: content });
      if (next === content) return false;
      await atomicWrite(target.absolute, next);
      return true;
    });
  }

  async move(source: string, destination: string, expectedRevision: string, signal?: AbortSignal): Promise<MutationResult> {
    const from = resolveMemoryPath(this.config.root, source);
    const to = resolveMemoryPath(this.config.root, destination);
    if (from.logical === to.logical) throw new Error("Source and destination are identical");
    return this.mutate("move", [from.logical, to.logical], expectedRevision, signal, async () => {
      await assertNoSymlinkSegments(this.config.root, from.logical);
      await assertNoSymlinkSegments(this.config.root, to.logical);
      const sourceInfo = await lstat(from.absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Memory file not found: ${from.logical}`);
        throw error;
      });
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Move source is not a regular file");
      if (await pathExists(to.absolute)) throw new Error(`Destination already exists: ${to.logical}`);
      await mkdir(dirname(to.absolute), { recursive: true });
      await rename(from.absolute, to.absolute);
      return true;
    });
  }

  async delete(path: string, expectedRevision: string, signal?: AbortSignal): Promise<MutationResult> {
    const target = resolveMemoryPath(this.config.root, path);
    return this.mutate("delete", [target.logical], expectedRevision, signal, async () => {
      await assertNoSymlinkSegments(this.config.root, target.logical);
      const info = await lstat(target.absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`Memory file not found: ${target.logical}`);
        throw error;
      });
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Memory target is not a regular file");
      await unlink(target.absolute);
      return true;
    });
  }

  private async mutate(
    operation: string,
    paths: readonly string[],
    expectedRevision: string,
    signal: AbortSignal | undefined,
    apply: () => Promise<boolean>,
  ): Promise<MutationResult> {
    return withRepositoryLock(this.config.root, async () => {
      const priorRevision = await this.requireHead(signal);
      if (expectedRevision !== priorRevision) {
        throw new Error(`Stale memory revision: expected ${expectedRevision}, current HEAD is ${priorRevision}`);
      }
      const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], { signal });
      if (status) throw new Error("Memory repository has uncommitted changes; inspect them and run /memfs-commit first");

      let applied = false;
      try {
        const changed = await apply();
        applied = changed;
        if (!changed) return { operation, paths, priorRevision, revision: priorRevision, changed: false };
        await this.validateWorkingTree();
        await this.git(["add", "-A", "--", ...paths], { signal });
        const staged = await this.git(["diff", "--cached", "--quiet"], { signal, allowFailure: true });
        void staged;
        await this.git(["commit", "-m", cleanMessage(`${operation}: ${paths.join(" -> ")}`, operation)], { signal });
        const revision = await this.requireHead(signal);
        return { operation, paths, priorRevision, revision, changed: true };
      } catch (error) {
        if (applied) {
          for (const path of paths) {
            try {
              await assertNoSymlinkSegments(this.config.root, path);
              await rm(resolveMemoryPath(this.config.root, path).absolute, { recursive: true, force: true });
            } catch {
              // A rejected symlink path must not be followed during cleanup.
            }
          }
        }
        await this.git(["reset", "--hard", priorRevision], { allowFailure: true });
        throw error;
      }
    });
  }

  async commitManualChanges(message: string, signal?: AbortSignal): Promise<MutationResult> {
    return withRepositoryLock(this.config.root, async () => {
      const priorRevision = await this.requireHead(signal);
      const porcelain = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], { signal });
      if (!porcelain) {
        return { operation: "manual-commit", paths: [], priorRevision, revision: priorRevision, changed: false };
      }
      await this.validateWorkingTree();
      const paths = await this.changedPaths(signal);
      try {
        await this.git(["add", "-A"], { signal });
        await this.git(["commit", "-m", cleanMessage(message, "Update local-memfs")], { signal });
      } catch (error) {
        await this.git(["reset", "--mixed", priorRevision], { allowFailure: true });
        throw error;
      }
      return {
        operation: "manual-commit",
        paths,
        priorRevision,
        revision: await this.requireHead(signal),
        changed: true,
      };
    });
  }

  private async changedPaths(signal?: AbortSignal): Promise<string[]> {
    const out = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal });
    const tokens = out.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const code = token.slice(0, 2);
      const path = token.slice(3);
      if (path) paths.push(path);
      if (code.includes("R") || code.includes("C")) {
        const next = tokens[++index];
        if (next) paths.push(next);
      }
    }
    return [...new Set(paths)].sort();
  }

  private async validateWorkingTree(): Promise<void> {
    let renderedSystemBytes = 0;
    let configSeen = false;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (directory === this.config.root && entry.name === ".git") continue;
        const absolute = resolve(directory, entry.name);
        const rel = relative(this.config.root, absolute).split("\\").join("/");
        if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in memory repositories: ${rel}`);
        if (entry.isDirectory()) {
          if (rel === ".memfs") {
            await visit(absolute);
          } else {
            if (rel.startsWith(".memfs/")) throw new Error(`Unexpected internal directory: ${rel}`);
            await visit(absolute);
          }
          continue;
        }
        if (!entry.isFile()) throw new Error(`Unsupported filesystem entry: ${rel}`);
        if (rel === ".memfs/config.json") {
          const parsed = JSON.parse(await readFile(absolute, "utf8")) as { schemaVersion?: unknown; agent?: unknown };
          if (parsed.schemaVersion !== 1 || parsed.agent !== this.config.agent) throw new Error("Invalid .memfs/config.json");
          configSeen = true;
          continue;
        }
        const logical = normalizeMemoryPath(rel);
        const content = await readFile(absolute, "utf8");
        const document = parseMemoryDocument(content);
        if (isSystemPath(logical)) {
          const section = renderSystemSection({ path: logical, description: document.description, body: document.body });
          renderedSystemBytes += Buffer.byteLength(`${section}\n\n`, "utf8");
        }
      }
    };
    await visit(this.config.root);
    if (!configSeen) throw new Error("Missing .memfs/config.json");
    if (renderedSystemBytes > LIMITS.maxSystemBytes) {
      throw new Error(`rendered system/ memory exceeds ${LIMITS.maxSystemBytes} bytes`);
    }
  }
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
