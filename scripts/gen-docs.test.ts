import { test, expect, describe } from "bun:test";
import { Marked } from "marked";
import { renderDoc, sanitizeDiagramSvg, type DiagramRenderer } from "./gen-docs";
import { DOCS } from "../src/docs.generated";

describe("renderDoc — metadata", () => {
  test("title comes from the first H1", async () => {
    expect((await renderDoc("# Title\n\nbody", "x")).title).toBe("Title");
  });

  test("slug is passed through", async () => {
    expect((await renderDoc("# A", "cli")).slug).toBe("cli");
  });

  test("description is the first paragraph as plain text", async () => {
    const doc = await renderDoc("# Title\n\nHello **world**.\n\nmore", "x");
    expect(doc.description).toBe("Hello world.");
  });

  test("code-span H1 is reduced to plain text (cli.md case)", async () => {
    expect((await renderDoc("# `@jsonl-tools/cli`", "cli")).title).toBe(
      "@jsonl-tools/cli",
    );
  });

  test("missing H1 falls back to the slug; missing paragraph → empty", async () => {
    const doc = await renderDoc("## subheading only", "fallback");
    expect(doc.title).toBe("fallback");
    expect(doc.description).toBe("");
  });

  test("H1 that strips to empty text falls back to the slug", async () => {
    expect((await renderDoc("# ![logo](logo.png)", "fallback")).title).toBe(
      "fallback",
    );
  });

  test("description prefers the paragraph after the H1, not a preamble", async () => {
    const doc = await renderDoc("Preamble line.\n\n# Title\n\nReal intro.", "x");
    expect(doc.description).toBe("Real intro.");
  });
});

describe("renderDoc — rendering", () => {
  test("fenced code is escaped inside a <pre><code> block", async () => {
    const html = (await renderDoc("```bash\n<script>x</script>\n```", "x")).html;
    expect(html).toContain("<pre>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("tables render as <table> with header and body cells", async () => {
    const html = (await renderDoc("| A | B |\n|---|---|\n| 1 | 2 |", "x")).html;
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  test("mermaid fence without a renderer falls back to an escaped code block", async () => {
    const html = (
      await renderDoc('```mermaid\nflowchart TB\n  A["x<br/>y"]\n```', "x")
    ).html;
    expect(html).toContain("<pre>");
    expect(html).toContain("flowchart TB");
    expect(html).toContain("&lt;br/&gt;");
    expect(html).not.toContain("<figure");
  });
});

describe("renderDoc — mermaid rendering", () => {
  const stub: DiagramRenderer = async (_def, seed) =>
    `<svg id="mmd-${seed}">DIAGRAM</svg>`;

  test("renders a mermaid fence to an inline <figure> SVG when a renderer is supplied", async () => {
    const html = (
      await renderDoc("```mermaid\nflowchart TB\nA-->B\n```", "sec", stub)
    ).html;
    expect(html).toContain('<figure class="docs-mermaid">');
    expect(html).toContain('<svg id="mmd-sec-0">');
    expect(html).toContain("DIAGRAM");
    expect(html).not.toContain('language-mermaid');
  });

  test("supplies a stable per-diagram seed (slug-index)", async () => {
    const seeds: string[] = [];
    const recorder: DiagramRenderer = async (_def, seed) => {
      seeds.push(seed);
      return `<svg id="mmd-${seed}"></svg>`;
    };
    await renderDoc(
      "```mermaid\nflowchart TB\nA-->B\n```\n\n```mermaid\nflowchart TB\nC-->D\n```",
      "sec",
      recorder,
    );
    expect(seeds).toEqual(["sec-0", "sec-1"]);
  });
});

describe("renderDoc — sanitization (R7)", () => {
  test("raw inline HTML tags are dropped (inner text may survive as inert text)", async () => {
    const html = (await renderDoc("Hello <script>alert(1)</script> world", "x"))
      .html;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script>");
    expect(html).toContain("Hello");
  });

  test("raw HTML with an event handler is dropped", async () => {
    const html = (
      await renderDoc("text\n\n<img src=x onerror=alert(1)>\n\ntext", "x")
    ).html;
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img");
  });

  test("javascript: link href is neutralized", async () => {
    const html = (await renderDoc("[click](javascript:alert(1))", "x")).html;
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  test("data: link href is neutralized", async () => {
    const html = (
      await renderDoc("[x](data:text/html,<script>1</script>)", "x")
    ).html;
    expect(html).not.toContain("data:");
  });

  test("external links get rel=noopener noreferrer", async () => {
    const html = (await renderDoc("[GitHub](https://github.com/vire)", "x")).html;
    expect(html).toContain('href="https://github.com/vire"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("relative links are left without a rel attribute", async () => {
    const html = (await renderDoc("[cli](./cli)", "x")).html;
    expect(html).toContain('href="./cli"');
    expect(html).not.toContain("noopener");
  });

  test("javascript: image src is neutralized (same guard as links)", async () => {
    const html = (await renderDoc("![x](javascript:alert(1))", "x")).html;
    expect(html).not.toContain("javascript:");
  });

  test("data: image src is neutralized", async () => {
    const html = (
      await renderDoc("![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)", "x")
    ).html;
    expect(html).not.toContain("data:");
  });
});

describe("sanitizeDiagramSvg", () => {
  test("rewrites the hardcoded my-svg root id to a unique per-diagram id", () => {
    const out = sanitizeDiagramSvg(
      '<svg id="my-svg"><style>#my-svg .node{fill:red}</style></svg>',
      "security-1",
    );
    expect(out).toContain('id="mmd-security-1"');
    expect(out).toContain("#mmd-security-1 .node");
    expect(out).not.toContain("my-svg");
  });

  test("strips <script> from the diagram SVG", () => {
    const out = sanitizeDiagramSvg(
      "<svg><script>alert(1)</script><g></g></svg>",
      "x",
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  test("strips inline event handlers", () => {
    expect(sanitizeDiagramSvg('<svg><g onload="x()"></g></svg>', "x")).not.toContain(
      "onload",
    );
  });
});

describe("committed artifact is in sync with docs/public (drift guard)", () => {
  // Diagram regions are non-deterministic SVG (generated ids, font metrics), so
  // they are normalized away on both sides; everything else is byte-compared.
  const stripMermaid = (h: string) =>
    h
      .replace(/<figure class="docs-mermaid">[\s\S]*?<\/figure>/g, "[MERMAID]")
      .replace(
        /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g,
        "[MERMAID]",
      );

  async function sourceFiles(): Promise<string[]> {
    const glob = new Bun.Glob("*.md");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: "docs/public" })) files.push(file);
    return files.sort();
  }

  test("docs.generated.ts matches a fresh render of the source (diagrams aside)", async () => {
    const bySlug = new Map(DOCS.map((d) => [d.slug, d]));
    for (const file of await sourceFiles()) {
      const slug = file.replace(/\.md$/, "");
      const md = await Bun.file(`docs/public/${file}`).text();
      const fresh = await renderDoc(md, slug); // no renderer → mermaid placeholder
      const committed = bySlug.get(slug);
      expect(committed).toBeDefined();
      expect(committed!.title).toBe(fresh.title);
      expect(committed!.description).toBe(fresh.description);
      expect(stripMermaid(committed!.html)).toBe(stripMermaid(fresh.html));
    }
  });

  test("every source mermaid fence produced a rendered <figure> in the artifact", async () => {
    const lexer = new Marked({ gfm: true });
    let total = 0;
    for (const file of await sourceFiles()) {
      const md = await Bun.file(`docs/public/${file}`).text();
      const fences = lexer
        .lexer(md)
        .filter(
          (t) => t.type === "code" && (t as { lang?: string }).lang?.trim() === "mermaid",
        ).length;
      const committed = DOCS.find((d) => d.slug === file.replace(/\.md$/, ""))!;
      const figures = (
        committed.html.match(/<figure class="docs-mermaid">/g) ?? []
      ).length;
      expect(figures).toBe(fences);
      total += fences;
    }
    expect(total).toBeGreaterThan(0); // at least the security.md diagrams
  });
});
