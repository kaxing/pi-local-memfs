import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LIMITS } from "./config.js";
import { contentHash } from "./git-store.js";
import { normalizeMemoryPath } from "./paths.js";
import type { RuntimeState } from "./runtime.js";
import { requireEnabledStore } from "./runtime.js";

export const MEMFS_TOOL_NAMES = [
  "memfs_list",
  "memfs_read",
  "memfs_search",
  "memfs_write",
  "memfs_edit",
  "memfs_move",
  "memfs_delete",
] as const;

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
}

const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;
const MAX_PAGE_BYTES = 40 * 1024;
const MAX_READ_CHARACTERS = 32 * 1024;

function text(content: string, details: Record<string, unknown> = {}) {
  if (Buffer.byteLength(content, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new Error("local-memfs tool result exceeded its output budget");
  }
  return { content: [{ type: "text" as const, text: content }], details };
}

function pageLines(lines: readonly string[], cursor: number, limit: number): { lines: string[]; nextCursor: number | null } {
  const page: string[] = [];
  let used = 0;
  let index = cursor;
  while (index < lines.length && page.length < limit) {
    const line = lines[index]!;
    const size = Buffer.byteLength(`${line}\n`, "utf8");
    if (page.length > 0 && used + size > MAX_PAGE_BYTES) break;
    if (size > MAX_PAGE_BYTES) throw new Error("A local-memfs result record exceeds the output budget");
    page.push(line);
    used += size;
    index++;
  }
  return { lines: page, nextCursor: index < lines.length ? index : null };
}

function pageText(value: string, offset: number, limit: number): { text: string; nextOffset: number | null; total: number } {
  const characters = Array.from(value);
  if (offset > characters.length) throw new Error(`Read offset exceeds ${characters.length} characters`);
  const page: string[] = [];
  let used = 0;
  let index = offset;
  while (index < characters.length && page.length < limit) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > MAX_PAGE_BYTES) break;
    page.push(character);
    used += size;
    index++;
  }
  return { text: page.join(""), nextOffset: index < characters.length ? index : null, total: characters.length };
}

function safePrefix(input: string | undefined): string {
  if (!input) return "";
  const value = input.replace(/^@/, "").replace(/\/+$/, "");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid memory path prefix");
  }
  return value;
}

function mutationDetails(result: {
  operation: string;
  paths: readonly string[];
  priorRevision: string;
  revision: string;
  changed: boolean;
}): Record<string, unknown> {
  return {
    operation: result.operation,
    paths: [...result.paths],
    priorRevision: result.priorRevision,
    revision: result.revision,
    changed: result.changed,
  };
}

export function registerMemfsTools(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerTool({
    name: "memfs_list",
    label: "MemFS List",
    description: "List committed local-memfs Markdown files and descriptions. Output is bounded and paginated.",
    promptSnippet: "List committed files in the active local-memfs profile",
    promptGuidelines: ["Use memfs_list only for memory paths, not workspace files."],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Optional directory/path prefix" })),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.maxListEntries })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const store = requireEnabledStore(state);
      const snapshot = await store.snapshot(undefined, signal);
      const prefix = safePrefix(params.path);
      const filtered = snapshot.entries.filter(
        (entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`),
      );
      const cursor = params.cursor ?? 0;
      const limit = params.limit ?? 50;
      const records = filtered.map((entry) => `${entry.path}${entry.description ? ` — ${entry.description.replace(/\s+/g, " ").trim()}` : ""}`);
      const page = pageLines(records, cursor, limit);
      const returnedEntries = filtered.slice(cursor, cursor + page.lines.length);
      return text(
        `revision: ${snapshot.revision}\n${page.lines.join("\n") || "(no files)"}\nnextCursor: ${page.nextCursor ?? "none"}`,
        { operation: "list", revision: snapshot.revision, paths: returnedEntries.map((entry) => entry.path), nextCursor: page.nextCursor },
      );
    },
  });

  pi.registerTool({
    name: "memfs_read",
    label: "MemFS Read",
    description: "Read the committed body of one local-memfs Markdown file with Unicode-character pagination.",
    promptSnippet: "Read a committed local-memfs file",
    promptGuidelines: ["Use memfs_read for memory paths surfaced by memfs_list or the memory tree."],
    parameters: Type.Object({
      path: Type.String({ description: "Relative memory .md path" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Unicode-character offset" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_CHARACTERS, description: "Maximum Unicode characters" })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const store = requireEnabledStore(state);
      const snapshot = await store.snapshot(undefined, signal);
      const logical = normalizeMemoryPath(params.path);
      const entry = snapshot.entries.find((candidate) => candidate.path === logical);
      if (!entry) throw new Error(`Memory file not found: ${logical}`);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 8 * 1024;
      const page = pageText(entry.body, offset, limit);
      return text(
        `path: ${entry.path}\ndescription: ${entry.description || "(none)"}\nrevision: ${snapshot.revision}\ncharacters: ${offset}-${offset + Array.from(page.text).length} of ${page.total}\n\n${page.text}\n\nnextOffset: ${page.nextOffset ?? "none"}`,
        { operation: "read", path: entry.path, revision: snapshot.revision, nextOffset: page.nextOffset, contentHash: contentHash(entry.body) },
      );
    },
  });

  pi.registerTool({
    name: "memfs_search",
    label: "MemFS Search",
    description: "Case-insensitive literal search over committed local-memfs paths, descriptions, and bodies.",
    promptSnippet: "Search committed local-memfs text",
    promptGuidelines: ["Use memfs_search for lexical recall; it does not perform semantic or workspace search."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String({ description: "Optional directory/path prefix" })),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.maxSearchMatches })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const store = requireEnabledStore(state);
      const snapshot = await store.snapshot(undefined, signal);
      const matches = await store.search(params.query, safePrefix(params.path), snapshot.revision, signal);
      const cursor = params.cursor ?? 0;
      const limit = params.limit ?? 20;
      const records = matches.map((match) => `${match.path}${match.line ? `:${match.line}` : ""}: ${match.snippet}`);
      const page = pageLines(records, cursor, limit);
      const returnedMatches = matches.slice(cursor, cursor + page.lines.length);
      return text(
        `revision: ${snapshot.revision}\n${page.lines.join("\n") || "(no matches)"}\nnextCursor: ${page.nextCursor ?? "none"}`,
        { operation: "search", revision: snapshot.revision, paths: [...new Set(returnedMatches.map((match) => match.path))], nextCursor: page.nextCursor },
      );
    },
  });

  pi.registerTool({
    name: "memfs_write",
    label: "MemFS Write",
    description: "Create or replace a committed local-memfs Markdown body. New files require description. Requires current HEAD revision.",
    promptSnippet: "Create or replace committed local-memfs memory",
    promptGuidelines: ["Use memfs_write only for durable facts worth preserving; pass the current committed revision."],
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
      description: Type.Optional(Type.String({ minLength: 1 })),
      expectedRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await requireEnabledStore(state).write(
        params.path,
        params.content,
        params.description,
        params.expectedRevision,
        signal,
      );
      return text(`${result.changed ? "Committed" : "No change"}: ${result.revision}`, mutationDetails(result));
    },
  });

  pi.registerTool({
    name: "memfs_edit",
    label: "MemFS Edit",
    description: "Replace exactly one occurrence in a committed local-memfs Markdown body without changing frontmatter.",
    promptSnippet: "Precisely edit committed local-memfs memory",
    promptGuidelines: ["Use memfs_edit for exact body-only changes and pass the current committed revision."],
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String(),
      expectedRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await requireEnabledStore(state).edit(
        params.path,
        params.oldText,
        params.newText,
        params.expectedRevision,
        signal,
      );
      return text(`${result.changed ? "Committed" : "No change"}: ${result.revision}`, mutationDetails(result));
    },
  });

  pi.registerTool({
    name: "memfs_move",
    label: "MemFS Move",
    description: "Move one committed local-memfs Markdown file without overwriting the destination.",
    promptSnippet: "Move committed local-memfs memory",
    promptGuidelines: ["Use memfs_move to reorganize memory and pass the current committed revision."],
    parameters: Type.Object({
      source: Type.String(),
      destination: Type.String(),
      expectedRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await requireEnabledStore(state).move(
        params.source,
        params.destination,
        params.expectedRevision,
        signal,
      );
      return text(`Committed: ${result.revision}`, mutationDetails(result));
    },
  });

  pi.registerTool({
    name: "memfs_delete",
    label: "MemFS Delete",
    description: "Delete one committed local-memfs Markdown file. Git history retains prior content.",
    promptSnippet: "Delete committed local-memfs memory",
    promptGuidelines: ["Use memfs_delete only when forgetting is intended and pass the current committed revision."],
    parameters: Type.Object({
      path: Type.String(),
      expectedRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await requireEnabledStore(state).delete(params.path, params.expectedRevision, signal);
      return text(`Committed: ${result.revision}`, mutationDetails(result));
    },
  });
}
