// Pure docs routing logic, shared by the docs page (docs-app.tsx) and its tests.
// Kept dependency-free and DOM-free so it is unit-testable without booting the
// server or a browser, mirroring data-view-core.ts / share-viewer-core.ts.
//
// `DocPage` is the stable shape the build-time generator emits into
// src/docs.generated.ts. The type lives here (hand-written, stable) rather than
// in the generated file so importers don't churn when the artifact regenerates.

export interface DocPage {
  /** URL slug — the source file's basename, e.g. "cli" for docs/public/cli.md. */
  slug: string;
  /** Plain-text title, derived from the document's first H1. */
  title: string;
  /** Plain-text first paragraph, used on the docs index. */
  description: string;
  /** Pre-rendered, build-time-sanitized HTML for the document body. */
  html: string;
}

export type DocResolution =
  | { kind: "index" }
  | { kind: "doc"; doc: DocPage }
  | { kind: "not-found"; slug: string };

/**
 * Resolve a URL pathname against the available docs.
 * - `/docs` (or `/docs/`) → the index listing
 * - `/docs/:slug` → the matching doc, or a not-found result
 * Trailing slashes are tolerated; any other shape falls back to the index.
 */
export function resolveDoc(pathname: string, docs: DocPage[]): DocResolution {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/docs") return { kind: "index" };

  const match = path.match(/^\/docs\/([^/]+)$/);
  if (!match) return { kind: "index" };

  const slug = decodeURIComponent(match[1]!);
  const doc = docs.find((d) => d.slug === slug);
  return doc ? { kind: "doc", doc } : { kind: "not-found", slug };
}
