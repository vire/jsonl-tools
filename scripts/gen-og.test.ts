import { test, expect, describe } from "bun:test";
import { buildOgCardSvg, OG_WIDTH, OG_HEIGHT } from "./gen-og";
import { BRAND } from "./gen-brand";

describe("buildOgCardSvg", () => {
  const svg = buildOgCardSvg();

  test("is a well-formed 1200×630 SVG", () => {
    expect(OG_WIDTH).toBe(1200);
    expect(OG_HEIGHT).toBe(630);
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain(`width="1200"`);
    expect(svg).toContain(`height="630"`);
    expect(svg).toContain(`viewBox="0 0 1200 630"`);
  });

  test("carries the brand wordmark and tagline", () => {
    expect(svg).toContain(">jsonl</tspan>");
    expect(svg).toContain(">-tools</tspan>");
    expect(svg).toContain("Browser tools for Agentic JSONL traces");
    expect(svg).toContain("jsonl-tools.dev");
  });

  test("uses the brand hue and the dark app background", () => {
    expect(svg).toContain(BRAND); // #9b86f5 — cog + "-tools" + url
    expect(svg).toContain("#0d1421"); // dark navy background
  });

  test("is inert — no script or event handlers (it is rasterized headless)", () => {
    expect(svg).not.toContain("<script");
    expect(svg).not.toMatch(/\son\w+=/i);
  });
});
