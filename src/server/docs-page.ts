// Server-side rendering of the /docs pages.
//
// The docs are static content (links + inline-SVG diagrams), so each page is
// emitted as complete HTML — crawlable WITHOUT JavaScript, with a correct
// per-page <head> (title, description, canonical). Bodies come pre-rendered and
// build-time-sanitized from src/docs.generated.ts; no client bundle ships for
// docs. The markup reuses the class names in src/docs.css (served statically),
// so the visual language is identical to the prior React surface.

import { resolveDoc, type DocResolution } from "../docs-core";
import { DOCS } from "../docs.generated";

export const SITE_ORIGIN = "https://jsonl-tools.dev";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Gear geometry mirrors src/site-logo.tsx (concept R1) — keep the two in sync if
// the tooth count or proportions change.
function gearRoundPath(teeth: number, R: number, root: number): string {
  const step = (Math.PI * 2) / teeth;
  const f = [0.18, 0.32, 0.68, 0.82] as const;
  const pt = (a: number, r: number) =>
    [(50 + Math.cos(a) * r).toFixed(2), (50 + Math.sin(a) * r).toFixed(2)] as const;
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const p0 = pt(a + step * f[0], root);
    const t0 = pt(a + step * f[0], R);
    const p1 = pt(a + step * f[1], R);
    const p2 = pt(a + step * f[2], R);
    const t3 = pt(a + step * f[3], R);
    const p3 = pt(a + step * f[3], root);
    d += `${i === 0 ? "M" : "L"}${p0[0]},${p0[1]}`;
    d += `Q${t0[0]},${t0[1]} ${p1[0]},${p1[1]}`;
    d += `L${p2[0]},${p2[1]}`;
    d += `Q${t3[0]},${t3[1]} ${p3[0]},${p3[1]}`;
  }
  return d + "Z";
}

const GEAR_PATH = gearRoundPath(8, 47, 35);

// Static equivalent of the <SiteLogo> component (src/site-logo.tsx).
const SITE_LOGO = `<span class="site-logo"><span class="site-logo__mark"><span class="site-logo__brace">{</span><svg class="site-logo__gear" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><mask id="site-logo-hole"><rect x="0" y="0" width="100" height="100" fill="white"></rect><circle cx="50" cy="50" r="17" fill="black"></circle></mask><path d="${GEAR_PATH}" fill="currentColor" mask="url(#site-logo-hole)"></path></svg><span class="site-logo__brace">}</span></span><span class="site-logo__word">jsonl<span class="site-logo__tools">-tools</span></span></span>`;

const INDEX_DESCRIPTION =
  "Reference documentation for jsonl-tools — the HTTP API, the CLI, and the zero-knowledge security model.";

// Social-card constants. A single branded 1200×630 card (src/og.png, generated
// by scripts/gen-og.ts) is the og:image / twitter:image for every page; the
// absolute URL is required because unfurlers fetch it un-authenticated. The
// card is only ever referenced from indexable docs — never the key-bearing /s/
// viewer — so no share metadata can leak into a link preview.
const SITE_NAME = "jsonl-tools";
const OG_IMAGE = `${SITE_ORIGIN}/og.png`;
const OG_IMAGE_ALT = "jsonl-tools — Browser tools for Agentic JSONL traces";

interface HeadOptions {
  title: string;
  description: string;
  canonicalPath: string;
  robots?: string;
  /** og:title / twitter:title; falls back to `title` (which carries the
   *  " · jsonl-tools" suffix). Pass the bare page title to avoid doubling the
   *  brand against og:site_name. */
  ogTitle?: string;
  ogType?: "website" | "article";
}

function renderHead({
  title,
  description,
  canonicalPath,
  robots,
  ogTitle,
  ogType,
}: HeadOptions): string {
  const socialTitle = ogTitle ?? title;
  // Cards always carry text, so fall back to the index blurb when a page (e.g.
  // not-found) has no description of its own.
  const socialDescription = description || INDEX_DESCRIPTION;
  const url = `${SITE_ORIGIN}${canonicalPath}`;
  return [
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${escapeHtml(title)}</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : "",
    `<link rel="canonical" href="${url}">`,
    robots ? `<meta name="robots" content="${robots}">` : "",
    // Open Graph (Facebook, Slack, LinkedIn, iMessage, Discord…)
    `<meta property="og:type" content="${ogType ?? "website"}">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${escapeHtml(socialTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(socialDescription)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">`,
    // Twitter / X large-image card
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(socialTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(socialDescription)}">`,
    `<meta name="twitter:image" content="${OG_IMAGE}">`,
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    '<link rel="stylesheet" href="/docs.css">',
    "</head>",
  ]
    .filter(Boolean)
    .join("\n  ");
}

function renderNav(activeSlug?: string): string {
  if (DOCS.length === 0) return "";
  const links = DOCS.map((d) => {
    const active = d.slug === activeSlug;
    const cls = "docs-nav__link" + (active ? " docs-nav__link--active" : "");
    const aria = active ? ' aria-current="page"' : "";
    return `<a href="/docs/${d.slug}" class="${cls}"${aria}>${escapeHtml(d.title)}</a>`;
  }).join("");
  return `<nav class="docs-nav" aria-label="Documentation">${links}</nav>`;
}

function renderChrome(activeSlug: string | undefined, main: string): string {
  return (
    `<div class="docs-page">` +
    `<header class="docs-header"><a class="docs-home" href="/" aria-label="jsonl-tools home">${SITE_LOGO}</a>${renderNav(activeSlug)}</header>` +
    main +
    `<footer class="docs-footer">&copy; 2026 jsonl-tools.dev · <a href="/" class="docs-inline-link">back to the app</a></footer>` +
    `</div>`
  );
}

function renderIndexMain(): string {
  if (DOCS.length === 0) {
    return `<main class="docs-main"><h1 class="docs-title">Documentation</h1><p class="docs-empty">No documentation pages are available.</p></main>`;
  }
  const items = DOCS.map((d) => {
    const desc = d.description
      ? `<p class="docs-index__desc">${escapeHtml(d.description)}</p>`
      : "";
    return `<li class="docs-index__item"><a href="/docs/${d.slug}" class="docs-index__link">${escapeHtml(d.title)}</a>${desc}</li>`;
  }).join("");
  return `<main class="docs-main"><h1 class="docs-title">Documentation</h1><ul class="docs-index">${items}</ul></main>`;
}

function renderDocMain(html: string): string {
  // html is pre-rendered and sanitized at build time (scripts/gen-docs.ts).
  return `<main class="docs-main"><article class="docs-article">${html}</article></main>`;
}

function renderNotFoundMain(slug: string): string {
  return `<main class="docs-main"><h1 class="docs-title">Page not found</h1><p class="docs-empty">There is no documentation page for <code>${escapeHtml(slug)}</code>. <a href="/docs" class="docs-inline-link">Back to all docs</a>.</p></main>`;
}

export interface DocsRender {
  html: string;
  status: number;
}

/** Render a complete docs HTML document for a (already canonicalized) pathname.
 *  Pure and DOM-free, so it is unit-testable. */
export function renderDocsPage(pathname: string): DocsRender {
  const resolution: DocResolution = resolveDoc(pathname, DOCS);

  let main: string;
  let head: string;
  let activeSlug: string | undefined;
  let status = 200;

  if (resolution.kind === "doc") {
    activeSlug = resolution.doc.slug;
    main = renderDocMain(resolution.doc.html);
    head = renderHead({
      title: `${resolution.doc.title} · jsonl-tools`,
      description: resolution.doc.description,
      canonicalPath: `/docs/${resolution.doc.slug}`,
      ogTitle: resolution.doc.title,
      ogType: "article",
    });
  } else if (resolution.kind === "not-found") {
    status = 404;
    main = renderNotFoundMain(resolution.slug);
    head = renderHead({
      title: "Page not found · jsonl-tools",
      description: "",
      canonicalPath: "/docs",
      robots: "noindex",
    });
  } else {
    main = renderIndexMain();
    head = renderHead({
      title: "Documentation · jsonl-tools",
      description: INDEX_DESCRIPTION,
      canonicalPath: "/docs",
      ogTitle: "Documentation",
    });
  }

  const html =
    `<!doctype html>\n<html lang="en">\n  ${head}\n  <body>\n    ${renderChrome(activeSlug, main)}\n  </body>\n</html>\n`;

  return { html, status };
}

/** Full request handler for the docs routes. Canonicalizes trailing-slash forms
 *  (/docs/cli/ → /docs/cli) with a 301 before rendering, so each page has one
 *  canonical URL. Kept here (not inline in index.ts) so it is unit-testable
 *  without importing index.ts, which would start the server on import. */
export function handleDocsRequest(req: Request): Response {
  const url = new URL(req.url);
  const canonical = url.pathname.replace(/\/+$/, "") || "/";
  if (canonical !== url.pathname) {
    return new Response(null, {
      status: 301,
      headers: { Location: canonical + url.search },
    });
  }
  const { html, status } = renderDocsPage(url.pathname);
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
