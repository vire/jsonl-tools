import { test, expect, describe } from "bun:test";
import { renderDocsPage, handleDocsRequest, SITE_ORIGIN } from "./docs-page";
import { DOCS } from "../docs.generated";

const cli = DOCS.find((d) => d.slug === "cli")!;

describe("renderDocsPage — index (/docs)", () => {
  const { html, status } = renderDocsPage("/docs");

  test("returns 200", () => {
    expect(status).toBe(200);
  });

  test("has the index title, description, and canonical", () => {
    expect(html).toContain("<title>Documentation · jsonl-tools</title>");
    expect(html).toContain('<meta name="description"');
    expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/docs">`);
  });

  test("lists every doc with a link", () => {
    for (const d of DOCS) {
      expect(html).toContain(`href="/docs/${d.slug}"`);
    }
  });

  test("is crawlable without JS (no script tag, content present)", () => {
    expect(html).not.toContain("<script");
    expect(html).toContain('<h1 class="docs-title">Documentation</h1>');
  });

  test("links the static stylesheet and favicon", () => {
    expect(html).toContain('<link rel="stylesheet" href="/docs.css">');
    expect(html).toContain('href="/favicon.svg"');
  });

  test("emits a website-type Open Graph card for the index", () => {
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<meta property="og:title" content="Documentation">');
    expect(html).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/docs">`);
    expect(html).toContain(`<meta property="og:image" content="${SITE_ORIGIN}/og.png">`);
  });
});

describe("renderDocsPage — a doc (/docs/cli)", () => {
  const { html, status } = renderDocsPage("/docs/cli");

  test("returns 200 with the doc's title, description, and canonical", () => {
    expect(status).toBe(200);
    expect(html).toContain(`<title>${cli.title} · jsonl-tools</title>`);
    expect(html).toContain('<meta name="description"');
    expect(html).toContain(cli.description.slice(0, 40));
    expect(html).toContain(
      `<link rel="canonical" href="${SITE_ORIGIN}/docs/cli">`,
    );
  });

  test("inlines the rendered article body (no JS needed)", () => {
    expect(html).toContain('<article class="docs-article">');
    expect(html).toContain(cli.html);
    expect(html).not.toContain("<script");
  });

  test("marks the active doc in the nav", () => {
    expect(html).toContain('aria-current="page"');
  });

  test("is not marked noindex", () => {
    expect(html).not.toContain('name="robots"');
  });

  test("emits Open Graph + Twitter card tags (article, bare title, absolute URLs)", () => {
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:site_name" content="jsonl-tools">');
    // og:title is the bare doc title — not doubled with the brand suffix.
    expect(html).toContain(`<meta property="og:title" content="${cli.title}">`);
    expect(html).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/docs/cli">`);
    expect(html).toContain(`<meta property="og:image" content="${SITE_ORIGIN}/og.png">`);
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<meta name="twitter:image" content="${SITE_ORIGIN}/og.png">`);
  });
});

describe("renderDocsPage — unknown slug", () => {
  const { html, status } = renderDocsPage("/docs/nope");

  test("returns 404 and a noindex not-found page", () => {
    expect(status).toBe(404);
    expect(html).toContain("Page not found");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("nope");
  });

  test("escapes a single-segment hostile slug (pure render)", () => {
    const { html } = renderDocsPage("/docs/<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html.toLowerCase()).not.toContain("<img"); // the `<` is escaped
    expect(html).toContain("<title>Page not found · jsonl-tools</title>");
  });
});

describe("handleDocsRequest — routing", () => {
  const get = (path: string) =>
    handleDocsRequest(new Request(`https://jsonl-tools.dev${path}`));

  test("renders a doc with 200 + html content-type", async () => {
    const res = get("/docs/cli");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>@jsonl-tools/cli · jsonl-tools</title>");
  });

  test("301s trailing-slash forms to the canonical path", () => {
    expect(get("/docs/cli/").status).toBe(301);
    expect(get("/docs/cli/").headers.get("location")).toBe("/docs/cli");
    expect(get("/docs/").headers.get("location")).toBe("/docs");
  });

  test("escapes a hostile slug end-to-end (URL-encoded request)", async () => {
    // The realistic vector: an encoded single-segment payload that decodes to
    // <script>…</script>. It must come back 404, escaped, with no live <script>.
    const res = handleDocsRequest(
      new Request("https://jsonl-tools.dev/docs/%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body.toLowerCase()).not.toContain("<script");
  });

  test("301 Location cannot be CRLF-injected", () => {
    // %0d%0a stays percent-encoded through URL parsing, so the Location header
    // is a single line and no second header can be smuggled in.
    const res = handleDocsRequest(
      new Request("https://jsonl-tools.dev/docs/x/%0d%0aX-Injected:1/"),
    );
    const loc = res.headers.get("location") ?? "";
    expect(loc).not.toContain("\n");
    expect(loc).not.toContain("\r");
    expect(res.headers.get("x-injected")).toBeNull();
  });
});

describe("renderDocsPage — output is well-formed", () => {
  test("every page is a complete HTML document", () => {
    for (const path of ["/docs", "/docs/api", "/docs/security", "/docs/nope"]) {
      const { html } = renderDocsPage(path);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain("</html>");
    }
  });
});
