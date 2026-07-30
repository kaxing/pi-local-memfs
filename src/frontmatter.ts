import YAML from "yaml";
import { LIMITS } from "./config.js";

export interface MemoryDocument {
  readonly body: string;
  readonly description: string;
  readonly data: Record<string, unknown>;
  readonly prefix: string;
  readonly hasFrontmatter: boolean;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n(?:\n)?/;

export function parseMemoryDocument(content: string): MemoryDocument {
  if (Buffer.byteLength(content, "utf8") > LIMITS.maxFileBytes) {
    throw new Error(`Memory file exceeds ${LIMITS.maxFileBytes} bytes`);
  }
  if (!content.startsWith("---\n")) {
    return { body: content, description: "", data: {}, prefix: "", hasFrontmatter: false };
  }

  const match = FRONTMATTER.exec(content);
  if (!match) throw new Error("Malformed YAML frontmatter: missing closing delimiter");

  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1] ?? "");
  } catch (error) {
    throw new Error(`Malformed YAML frontmatter: ${(error as Error).message}`);
  }
  if (parsed == null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Malformed YAML frontmatter: expected a mapping");
  }

  const data = parsed as Record<string, unknown>;
  const rawDescription = data.description;
  if (rawDescription !== undefined && (typeof rawDescription !== "string" || !rawDescription.trim())) {
    throw new Error("Frontmatter description must be a non-empty string");
  }
  if (typeof rawDescription === "string" && Buffer.byteLength(rawDescription, "utf8") > LIMITS.maxDescriptionBytes) {
    throw new Error(`Frontmatter description exceeds ${LIMITS.maxDescriptionBytes} bytes`);
  }

  const prefix = match[0];
  return {
    body: content.slice(prefix.length),
    description: typeof rawDescription === "string" ? rawDescription : "",
    data,
    prefix,
    hasFrontmatter: true,
  };
}

export function serializeMemoryDocument(
  body: string,
  options: { existing?: string | undefined; description?: string | undefined },
): string {
  const existing = options.existing === undefined ? undefined : parseMemoryDocument(options.existing);
  const requested = options.description?.trim();

  if (!existing && !requested) throw new Error("description is required when creating a memory file");

  let content: string;
  if (existing && options.description === undefined) {
    content = `${existing.prefix}${body}`;
  } else if (existing && requested === existing.description) {
    content = `${existing.prefix}${body}`;
  } else {
    const data = { ...(existing?.data ?? {}), description: requested ?? existing?.description };
    if (typeof data.description !== "string" || !data.description.trim()) {
      throw new Error("description must be a non-empty string");
    }
    if (Buffer.byteLength(data.description, "utf8") > LIMITS.maxDescriptionBytes) {
      throw new Error(`description exceeds ${LIMITS.maxDescriptionBytes} bytes`);
    }
    const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
    content = `---\n${yaml}\n---\n\n${body}`;
  }

  if (Buffer.byteLength(content, "utf8") > LIMITS.maxFileBytes) {
    throw new Error(`Memory file exceeds ${LIMITS.maxFileBytes} bytes`);
  }
  return content;
}
