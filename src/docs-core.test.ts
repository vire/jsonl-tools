import { test, expect, describe } from "bun:test";
import { resolveDoc, type DocPage } from "./docs-core";

const DOCS: DocPage[] = [
  { slug: "api", title: "API", description: "", html: "<p>api</p>" },
  { slug: "cli", title: "CLI", description: "", html: "<p>cli</p>" },
  { slug: "security", title: "Security", description: "", html: "<p>sec</p>" },
];

describe("resolveDoc", () => {
  test("/docs → index", () => {
    expect(resolveDoc("/docs", DOCS)).toEqual({ kind: "index" });
  });

  test("/docs/ (trailing slash) → index", () => {
    expect(resolveDoc("/docs/", DOCS)).toEqual({ kind: "index" });
  });

  test("/docs/cli → the cli doc", () => {
    const r = resolveDoc("/docs/cli", DOCS);
    expect(r).toEqual({ kind: "doc", doc: DOCS[1]! });
  });

  test("/docs/api and /docs/security → their docs", () => {
    expect(resolveDoc("/docs/api", DOCS)).toEqual({ kind: "doc", doc: DOCS[0]! });
    expect(resolveDoc("/docs/security", DOCS)).toEqual({
      kind: "doc",
      doc: DOCS[2]!,
    });
  });

  test("trailing slash on a slug still resolves", () => {
    expect(resolveDoc("/docs/cli/", DOCS)).toEqual({ kind: "doc", doc: DOCS[1]! });
  });

  test("unknown slug → not-found (carries the slug)", () => {
    expect(resolveDoc("/docs/nope", DOCS)).toEqual({
      kind: "not-found",
      slug: "nope",
    });
  });

  test("empty docs list → unknown slug is not-found", () => {
    expect(resolveDoc("/docs/cli", [])).toEqual({ kind: "not-found", slug: "cli" });
  });
});
