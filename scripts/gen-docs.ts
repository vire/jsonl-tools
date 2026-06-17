// Docs page generator for jsonl-tools (run: `bun run gen:docs`).
//
// Reads every Markdown file in docs/public/, converts each to sanitized HTML at
// BUILD TIME, and writes the committed src/docs.generated.ts module that the
// docs browser bundle imports. The conversion happens here — ahead of serving —
// so `marked` (and the mermaid toolchain) stay devDependencies: they never reach
// a browser bundle (enforced by src/boundary.test.ts) nor the pruned production
// image. This mirrors scripts/gen-brand.ts: edit the generator, re-run it, and
// commit the output; never hand-edit src/docs.generated.ts.
//
// Sanitization (R7): the renderer drops raw HTML so authored Markdown cannot emit
// live markup, and rewrites link/image URLs to neutralize javascript:/data:/
// vbscript: schemes (adding rel="noopener noreferrer" to external links).
// Content is first-party, so this build-time pass is sufficient without a DOM
// sanitizer. Fenced ```mermaid blocks are rendered to inline SVG at build time
// (via @mermaid-js/mermaid-cli + headless Chromium); other fences render as
// escaped <pre><code>.

import { Marked, type Tokens } from "marked";
import type { DocPage } from "../src/docs-core";

const DOCS_DIR = "docs/public";
const OUT_FILE = "src/docs.generated.ts";

const DANGEROUS_SCHEME = /^\s*(?:javascript|data|vbscript):/i;
const EXTERNAL = /^https?:\/\//i;

/** Renders a mermaid definition to an inline-ready SVG string. Injected into
 *  renderDoc so unit tests stay browser-free; when absent, mermaid fences fall
 *  back to escaped code blocks. */
export type DiagramRenderer = (definition: string, seed: string) => Promise<string>;

// Mermaid theme mapped to the design tokens (see DESIGN.md). themeVariables take
// solid hex values; these mirror :root in src/index.css.
const MERMAID_CONFIG = {
  theme: "base",
  securityLevel: "strict",
  deterministicIds: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  themeVariables: {
    background: "#0d1421",
    primaryColor: "#16202e",
    primaryBorderColor: "#1ba6c9",
    primaryTextColor: "#e8edf6",
    secondaryColor: "#1b2536",
    tertiaryColor: "#1b2536",
    lineColor: "#6b7892",
    fontSize: "14px",
  },
} as const;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip HTML tags and decode the handful of entities marked emits, for titles
 *  and descriptions that should be plain text (e.g. a code-span H1). */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Make a build-time-rendered mermaid SVG safe and collision-free to inline:
 *  mermaid-cli hardcodes the root id "my-svg" (which collides when a page has 2+
 *  diagrams and its scoped <style> would cross-apply), so rewrite it to a unique
 *  per-diagram id; and strip any <script>/inline event handlers defensively —
 *  mermaid's strict SVG output carries none, but this is injected via
 *  dangerouslySetInnerHTML, so fail closed. */
export function sanitizeDiagramSvg(rawSvg: string, seed: string): string {
  return rawSvg
    .replace(/my-svg/g, `mmd-${seed}`)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
}

/** A marked instance whose renderer enforces the sanitization contract (R7) and
 *  swaps mermaid fences for their pre-rendered SVG (keyed by fence text). */
function buildMarked(diagrams: Map<string, string>): Marked {
  const m = new Marked({ gfm: true });
  m.use({
    renderer: {
      // Drop raw/inline HTML tokens entirely — no passthrough of authored markup.
      html() {
        return "";
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const safeHref = DANGEROUS_SCHEME.test(href) ? "#" : href;
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        const relAttr = EXTERNAL.test(safeHref) ? ` rel="noopener noreferrer"` : "";
        return `<a href="${escapeAttr(safeHref)}"${titleAttr}${relAttr}>${text}</a>`;
      },
      // Apply the same scheme filter to image URLs — marked's default image
      // renderer does no scheme filtering, so without this an authored
      // ![](javascript:…) / ![](data:…) would bypass the link guard (R7).
      image({ href, title, text }) {
        const safeHref = DANGEROUS_SCHEME.test(href) ? "" : href;
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return `<img src="${escapeAttr(safeHref)}" alt="${escapeAttr(text)}"${titleAttr}>`;
      },
      // ```mermaid → pre-rendered inline SVG when available; everything else (and
      // mermaid without a renderer) is an escaped code block.
      code({ text, lang }) {
        const language = (lang || "").trim();
        if (language === "mermaid") {
          const svg = diagrams.get(text);
          if (svg) return `<figure class="docs-mermaid">${svg}</figure>\n`;
        }
        const cls = language ? ` class="language-${escapeAttr(language)}"` : "";
        return `<pre><code${cls}>${escapeHtml(text)}\n</code></pre>\n`;
      },
    },
  });
  return m;
}

/** Convert one Markdown document to a DocPage. Pure aside from the injected
 *  `renderDiagram` (no filesystem) so tests can drive it directly; the main
 *  block below supplies the real, Chromium-backed diagram renderer. */
export async function renderDoc(
  markdown: string,
  slug: string,
  renderDiagram?: DiagramRenderer,
): Promise<DocPage> {
  const tokens = new Marked({ gfm: true }).lexer(markdown);

  // Render mermaid fences to SVG up front (async), keyed by their definition, so
  // the synchronous marked renderer can look each one up by fence text.
  const diagrams = new Map<string, string>();
  if (renderDiagram) {
    let i = 0;
    for (const t of tokens) {
      if (t.type === "code" && (t as Tokens.Code).lang?.trim() === "mermaid") {
        const def = (t as Tokens.Code).text;
        if (!diagrams.has(def)) {
          diagrams.set(def, await renderDiagram(def, `${slug}-${i}`));
        }
        i++;
      }
    }
  }

  const m = buildMarked(diagrams);

  const h1 = tokens.find(
    (t): t is Tokens.Heading => t.type === "heading" && t.depth === 1,
  );
  // Fall back to the slug when there is no H1 *or* the H1 strips to empty text
  // (e.g. an image-only heading), so the nav/index never renders a blank title.
  const title = (h1 && toPlainText(m.parseInline(h1.text) as string)) || slug;

  // Index description = first paragraph after the H1 (falling back to the first
  // paragraph anywhere if none follows), matching "the intro under the title".
  const afterH1 = h1 ? tokens.slice(tokens.indexOf(h1) + 1) : tokens;
  const isPara = (t: (typeof tokens)[number]): t is Tokens.Paragraph =>
    t.type === "paragraph";
  const para = afterH1.find(isPara) ?? tokens.find(isPara);
  const description = para
    ? toPlainText(m.parseInline(para.text) as string)
    : "";

  const html = m.parser(tokens);

  return { slug, title, description, html };
}

function renderModule(docs: DocPage[]): string {
  return (
    "// GENERATED FILE — do not edit by hand.\n" +
    "// Run `bun run gen:docs` to regenerate from docs/public/*.md.\n" +
    '// The generator is scripts/gen-docs.ts; the source of truth is docs/public/.\n\n' +
    'import type { DocPage } from "./docs-core";\n\n' +
    `export const DOCS: DocPage[] = ${JSON.stringify(docs, null, 2)};\n`
  );
}

export async function generate(): Promise<DocPage[]> {
  const glob = new Bun.Glob("*.md");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: DOCS_DIR })) files.push(file);
  files.sort();

  // Puppeteer + mermaid-cli are loaded here (not at module top) so importing this
  // file for its pure helpers — as the tests do — never spins up a browser.
  const puppeteer = (await import("puppeteer")).default as {
    launch: (opts: unknown) => Promise<{ close: () => Promise<void> }>;
  };
  const { renderMermaid } = (await import("@mermaid-js/mermaid-cli")) as unknown as {
    renderMermaid: (
      browser: unknown,
      definition: string,
      outputFormat: string,
      opts: unknown,
    ) => Promise<{ data: Uint8Array }>;
  };

  const browser = await puppeteer.launch({ headless: true });
  const renderDiagram: DiagramRenderer = async (definition, seed) => {
    const { data } = await renderMermaid(browser, definition, "svg", {
      mermaidConfig: MERMAID_CONFIG,
      backgroundColor: "transparent",
    });
    return sanitizeDiagramSvg(new TextDecoder().decode(data), seed);
  };

  try {
    const docs: DocPage[] = [];
    for (const file of files) {
      const markdown = await Bun.file(`${DOCS_DIR}/${file}`).text();
      docs.push(await renderDoc(markdown, file.replace(/\.md$/, ""), renderDiagram));
    }
    await Bun.write(OUT_FILE, renderModule(docs));
    return docs;
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const docs = await generate();
  console.log(`wrote ${OUT_FILE} (${docs.map((d) => d.slug).join(", ")})`);
}
