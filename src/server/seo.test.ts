import { test, expect, describe } from "bun:test";
import { sitemapXml, robotsTxt, publicUrls } from "./seo";
import { DOCS } from "../docs.generated";
import { SITE_ORIGIN } from "./docs-page";

describe("sitemap.xml", () => {
  const xml = sitemapXml();

  test("is well-formed and lists home + docs index", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<urlset");
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/docs</loc>`);
  });

  test("includes every doc", () => {
    for (const d of DOCS) {
      expect(xml).toContain(`<loc>${SITE_ORIGIN}/docs/${d.slug}</loc>`);
    }
    // home + index + one per doc
    const count = (xml.match(/<loc>/g) ?? []).length;
    expect(count).toBe(DOCS.length + 2);
  });

  test("never lists the key-bearing share viewer", () => {
    expect(xml).not.toContain("/s/");
  });
});

describe("robots.txt", () => {
  const txt = robotsTxt();

  test("disallows /s/ and references the sitemap", () => {
    expect(txt).toContain("Disallow: /s/");
    expect(txt).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  test("allows the rest", () => {
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
  });
});

describe("publicUrls", () => {
  test("excludes /s/ entirely", () => {
    expect(publicUrls().some((u) => u.includes("/s/"))).toBe(false);
  });
});
