import { describe, expect, it } from "vitest";
import { parseMemoryDocument, serializeMemoryDocument } from "../src/frontmatter.js";

describe("Markdown frontmatter", () => {
  it("serializes and parses a new document", () => {
    const content = serializeMemoryDocument("Hello\nworld", { description: "Greeting" });
    expect(content).toContain("description: Greeting");
    expect(parseMemoryDocument(content)).toMatchObject({ body: "Hello\nworld", description: "Greeting" });
  });

  it("preserves raw frontmatter and unknown keys when description is unchanged", () => {
    const existing = `---\ndescription: "Human style"\ncustom: [one, two]\n---\n\nOld body`;
    const next = serializeMemoryDocument("New body", { existing });
    expect(next).toBe(`---\ndescription: "Human style"\ncustom: [one, two]\n---\n\nNew body`);
  });

  it("preserves unknown keys when changing description", () => {
    const existing = `---\ndescription: Old\ncustom: yes\n---\n\nBody`;
    const next = serializeMemoryDocument("Body", { existing, description: "New" });
    const parsed = parseMemoryDocument(next);
    expect(parsed.description).toBe("New");
    expect(parsed.data.custom).toBe("yes");
  });

  it("accepts body-only manual files but requires descriptions on model creation", () => {
    expect(parseMemoryDocument("plain body")).toMatchObject({ body: "plain body", description: "" });
    expect(() => serializeMemoryDocument("body", {})).toThrow(/description/);
  });

  it("rejects malformed frontmatter instead of rewriting it", () => {
    const malformed = "---\ndescription: [broken\n---\n\nbody";
    expect(() => parseMemoryDocument(malformed)).toThrow(/Malformed YAML/);
    expect(() => serializeMemoryDocument("new", { existing: malformed })).toThrow(/Malformed YAML/);
  });

  it("bounds descriptions independently from file bodies", () => {
    expect(() => serializeMemoryDocument("body", { description: "x".repeat(1025) })).toThrow(/description exceeds/);
  });
});
