// Published-artifact boundary guard (plan U7). Walks cli/index.ts's transitive
// relative-import graph and asserts no module under src/server/ is reachable.
// Higher stakes than the browser boundary test: this graph is what `bun build`
// bundles into a PUBLIC npm package, so a stray server import would ship Postgres
// access / secrets to every `npx` user.

import { test, expect } from "bun:test";

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
const SKIP_EXT = /\.(css|svg|jsonl|json|png|jpe?g|gif|webp)$/i;
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

async function buildGraph(entryAbs: string): Promise<{ files: Set<string>; packages: Set<string> }> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = [entryAbs];
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
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        packages.add(pkg);
      }
    }
  }
  return { files, packages };
}

const ENTRY = new URL("./index.ts", import.meta.url).pathname;

test("the CLI bundle reaches no src/server/ module", async () => {
  const { files } = await buildGraph(ENTRY);
  const leaked = [...files].filter((f) => f.includes("/src/server/"));
  expect(leaked, "cli/index.ts must not bundle server-only code into the published package").toEqual([]);
});

test("the CLI bundle's shared src/ modules read no non-public process.env secret", async () => {
  // The CLI itself (cli/*) legitimately reads JSONL_TOOLS_* config at runtime; the
  // concern is the bundled src/ crypto modules staying secret-free.
  const { files } = await buildGraph(ENTRY);
  const envRe = /process\.env\.([A-Z0-9_]+)/g;
  for (const file of files) {
    if (!file.includes("/src/")) continue; // only the shared src/ modules
    const src = await Bun.file(file).text();
    for (const m of src.matchAll(envRe)) {
      throw new Error(`${file} reads process.env.${m[1]} — shared src/ modules in the CLI bundle must be secret-free.`);
    }
  }
});
