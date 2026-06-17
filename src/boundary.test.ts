// Client/server boundary guard (plan U1).
//
// Walks each browser entry's transitive relative-import graph and asserts:
//  - no module under src/server/ is reachable (server code/secrets never bundle)
//  - no non-public process.env secret is read in a browser-reachable module
//  - analytics-free entries (the viewer and create surfaces, added in U3/U4) do
//    not import the third-party analytics SDK
//
// This is enforcement, not discipline: an accidental `import ... from "./server/db"`
// in a browser module fails this test instead of silently shipping a secret.

import { test, expect } from "bun:test";

const ROOT = new URL("../", import.meta.url).pathname; // repo root

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
const SKIP_EXT = /\.(css|svg|jsonl|json|png|jpe?g|gif|webp)$/i;

// Browser entry points. The docs surface has no browser entry — it is
// server-rendered to static HTML (src/server/docs-page.ts) — so its build
// toolchain (marked, mermaid-cli, puppeteer) cannot reach a browser bundle by
// construction.
const BROWSER_ENTRIES = [
  "src/frontend.tsx",
  "src/bulk-analyzer-frontend.tsx",
  "src/share-frontend.tsx",
];

// Entries that must never load a third-party script (R22): the home page is the
// share-create surface and share-frontend.tsx is the viewer — both hold a key or
// plaintext. (bulk-analyzer is not key-bearing and is exempt.)
const ANALYTICS_FREE_ENTRIES = ["src/frontend.tsx", "src/share-frontend.tsx"];
const ANALYTICS_PACKAGE = "roaarrr-browser";

interface Graph {
  files: Set<string>;
  packages: Set<string>;
}

const IMPORT_RE =
  /(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

async function resolveRelative(fromFile: string, spec: string): Promise<string | null> {
  const basePath = new URL(spec, `file://${fromFile}`).pathname;
  for (const ext of RESOLVE_EXTS) {
    const candidate = basePath + ext;
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

async function buildGraph(entryRel: string): Promise<Graph> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = [ROOT + entryRel];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);

    let src: string;
    try {
      src = await Bun.file(file).text();
    } catch {
      continue;
    }

    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec || SKIP_EXT.test(spec)) continue;

      if (spec.startsWith(".") || spec.startsWith("/")) {
        const resolved = await resolveRelative(file, spec);
        if (resolved) stack.push(resolved);
      } else {
        // bare specifier — record the package root (handle @scope/name)
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0]!;
        packages.add(pkg);
      }
    }
  }

  return { files, packages };
}

test("no browser entry reaches a src/server/ module", async () => {
  for (const entry of BROWSER_ENTRIES) {
    const { files } = await buildGraph(entry);
    const leaked = [...files].filter((f) => f.includes("/src/server/"));
    expect(leaked, `${entry} must not import server-only code`).toEqual([]);
  }
});

test("no browser-reachable module reads a non-public process.env secret", async () => {
  const envRe = /process\.env\.([A-Z0-9_]+)/g;
  const allowed = new Set(["NODE_ENV"]);
  for (const entry of BROWSER_ENTRIES) {
    const { files } = await buildGraph(entry);
    for (const file of files) {
      let src: string;
      try {
        src = await Bun.file(file).text();
      } catch {
        continue;
      }
      for (const m of src.matchAll(envRe)) {
        const name = m[1]!;
        if (allowed.has(name) || name.startsWith("BUN_PUBLIC_")) continue;
        throw new Error(
          `${file} reads process.env.${name} in a browser-reachable module — ` +
            `secrets must be server-only (BUN_PUBLIC_-prefixed vars are inlined).`,
        );
      }
    }
  }
});

test("analytics-free entries do not import the third-party analytics SDK", async () => {
  for (const entry of ANALYTICS_FREE_ENTRIES) {
    const { packages } = await buildGraph(entry);
    expect(
      packages.has(ANALYTICS_PACKAGE),
      `${entry} must not import ${ANALYTICS_PACKAGE} (R22)`,
    ).toBe(false);
  }
});

// --- session-id.ts guardrails (plan U4) ---
//
// The first-party session module is imported by the key-bearing home and viewer
// surfaces. It must stay URL-blind — it may read sessionStorage, crypto, and the
// outgoing request, but NOT any page-URL/navigation state — and it must add only
// the two allowlisted anon headers to a request. We assert this on the module's
// own source. The existing blanket entry-graph scan can't express this, since
// other modules on those surfaces (App.tsx, api-client.ts, share-viewer.tsx)
// legitimately read window.location; this is scoped to the session module.

const SESSION_MODULE = ROOT + "src/session-id.ts";
const ANON_HEADERS = new Set(["x-anon-session", "x-anon-surface"]);

// Page-URL / navigation state the session module must never touch.
const URL_STATE_RE = [/\blocation\b/i, /\breferrer\b/i, /\.hash\b/, /\.search\b/];
function referencesUrlState(src: string): boolean {
  return URL_STATE_RE.some((re) => re.test(src));
}
// Header names the module writes that are NOT one of the two allowlisted ones.
function nonAllowlistedHeaders(src: string): string[] {
  return [...src.matchAll(/headers\.set\(\s*["']([^"']+)["']/gi)]
    .map((m) => m[1]!.toLowerCase())
    .filter((name) => !ANON_HEADERS.has(name));
}

test("session-id.ts is URL-blind and sets only the two anon headers (R22)", async () => {
  const src = await Bun.file(SESSION_MODULE).text();
  expect(
    referencesUrlState(src),
    "session-id.ts must not reference location/hash/search/referrer",
  ).toBe(false);
  expect(
    nonAllowlistedHeaders(src),
    "session-id.ts must set only X-Anon-Session / X-Anon-Surface",
  ).toEqual([]);
});

test("the URL-blindness + header-allowlist guards catch a regressed module", () => {
  // A module that reads the URL fragment must trip the URL-state guard…
  expect(referencesUrlState(`const k = window.location.hash;`)).toBe(true);
  expect(referencesUrlState(`document.referrer`)).toBe(true);
  // …and one that smuggles an extra header must trip the allowlist guard.
  const extra = `headers.set("X-Anon-Surface", s); headers.set("X-Forwarded-For", ip);`;
  expect(nonAllowlistedHeaders(extra)).toEqual(["x-forwarded-for"]);
  // The real allowlisted headers, in any case, are fine.
  expect(nonAllowlistedHeaders(`headers.set('X-Anon-Session', id)`)).toEqual([]);
});
