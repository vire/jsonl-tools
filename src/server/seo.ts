// SEO discovery files: sitemap.xml and robots.txt, served by Bun.serve.
//
// Both are derived from the docs known at build time (src/docs.generated.ts), so
// they stay in sync with the docs automatically. The sitemap lists the public,
// indexable surfaces (home + docs); it deliberately omits /s/ (the key-bearing
// share viewer), which robots.txt also disallows and share.html marks noindex.

import { DOCS } from "../docs.generated";
import { SITE_ORIGIN } from "./docs-page";

/** Public, indexable URLs: the app home, the docs index, and each doc. */
export function publicUrls(): string[] {
  return [
    `${SITE_ORIGIN}/`,
    `${SITE_ORIGIN}/docs`,
    ...DOCS.map((d) => `${SITE_ORIGIN}/docs/${d.slug}`),
  ];
}

export function sitemapXml(): string {
  const urls = publicUrls()
    .map((loc) => `  <url><loc>${loc}</loc></url>`)
    .join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls +
    "\n</urlset>\n"
  );
}

export function robotsTxt(): string {
  return [
    "User-agent: *",
    "Allow: /",
    // /s/ is the key-bearing recipient viewer — never index or crawl it.
    "Disallow: /s/",
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}
