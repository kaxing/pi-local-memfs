import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LIMITS } from "./config.js";

const RESERVED_ROOTS = new Set([".git", ".memfs", "skills"]);

export function normalizeMemoryPath(input: string): string {
  let logical = input.startsWith("@") ? input.slice(1) : input;
  if (!logical || /[\u0000-\u001f\u007f]/.test(logical)) {
    throw new Error("Memory path is empty or contains control characters");
  }
  if (logical.includes("\\")) throw new Error("Memory paths must use POSIX '/' separators");
  if (isAbsolute(logical) || logical.startsWith("/") || /^[A-Za-z]:\//.test(logical)) {
    throw new Error("Memory path must be relative");
  }
  if (logical.length > LIMITS.maxPathLength) throw new Error(`Memory path exceeds ${LIMITS.maxPathLength} characters`);

  const parts = logical.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Memory path contains an invalid segment");
  }
  if (RESERVED_ROOTS.has(parts[0]!.toLocaleLowerCase())) throw new Error(`Memory path '${parts[0]}' is reserved`);
  if (!logical.endsWith(".md")) throw new Error("Memory files must use the .md extension");
  return logical;
}

export function resolveMemoryPath(root: string, input: string): { logical: string; absolute: string } {
  const logical = normalizeMemoryPath(input);
  const absolute = resolve(root, ...logical.split("/"));
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Memory path escapes its repository");
  }
  return { logical, absolute };
}

export async function assertNoSymlinkSegments(root: string, input: string): Promise<void> {
  const { logical } = resolveMemoryPath(root, input);
  let current = resolve(root);
  for (const part of logical.split("/")) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Memory path crosses symlink '${part}'`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function isSystemPath(logical: string): boolean {
  return logical.startsWith("system/");
}
