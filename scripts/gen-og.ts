// Open Graph card generator for jsonl-tools (run: `bun run gen:og`).
//
// Emits src/og.png — the single 1200×630 social card used as `og:image` /
// `twitter:image` for every indexable page (home + docs). Link unfurlers
// (Slack, X, LinkedIn, iMessage, Discord) want a RASTER image at that size;
// SVG og:images are widely rejected. So we compose the card as an SVG from the
// shared brand primitives (scripts/gen-brand.ts) and rasterize it with the
// puppeteer we already pull in for mermaid (scripts/gen-docs.ts).
//
// Like gen-brand / gen-docs: edit the generator, re-run it, and COMMIT the
// output. Never hand-edit src/og.png. The pure card builder is exported so the
// test can assert its structure without launching a browser.

import { cogPath, bracePath, BRAND, NEUTRAL_DARK_BG } from "./gen-brand";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const BG = "#0d1421"; // dark navy — the app's :root background (DESIGN.md)
const MUTED = "#9aa6bd"; // tagline ink, legible on the dark card
const TAGLINE = "Browser tools for Agentic JSONL traces";
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/** The 1200×630 social card as a self-contained SVG string. Pure — no I/O, no
 *  browser — so it is unit-testable; gen() below rasterizes it to PNG. The card
 *  background is fixed dark, so it uses the dark-bg neutral directly (no
 *  prefers-color-scheme flip, unlike the brand SVGs). */
export function buildOgCardSvg(): string {
  // The { cog } jsonl-tools lockup is authored in logo.svg's 372×64 coordinate
  // space, then scaled up and centred on the card via one group transform, so
  // the proportions stay identical to the wordmark used in the header.
  const scale = 2.4;
  const lockupW = 372 * scale;
  const tx = (OG_WIDTH - lockupW) / 2;
  const ty = 180;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" role="img" aria-label="jsonl-tools — ${TAGLINE}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${BG}"/>
  <!-- faint oversized cog watermark, bleeding off the bottom-right corner -->
  <path fill="${BRAND}" opacity="0.06" fill-rule="evenodd" d="${cogPath(1090, 600, 300, 220, 120)}"/>
  <!-- { cog } jsonl-tools lockup, centred -->
  <g transform="translate(${tx.toFixed(2)} ${ty}) scale(${scale})">
    <path fill="none" stroke="${NEUTRAL_DARK_BG}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" d="${bracePath("left", 26, 10, 44, 15)}"/>
    <path fill="${BRAND}" fill-rule="evenodd" d="${cogPath(58, 32, 23, 17, 8)}"/>
    <path fill="none" stroke="${NEUTRAL_DARK_BG}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" d="${bracePath("right", 90, 10, 44, 15)}"/>
    <text x="120" y="43" font-family="${MONO}" font-size="34" font-weight="700" letter-spacing="-0.5"><tspan fill="${NEUTRAL_DARK_BG}">jsonl</tspan><tspan fill="${BRAND}">-tools</tspan></text>
  </g>
  <text x="${OG_WIDTH / 2}" y="455" text-anchor="middle" font-family="${MONO}" font-size="32" fill="${MUTED}">${TAGLINE}</text>
  <text x="${OG_WIDTH / 2}" y="560" text-anchor="middle" font-family="${MONO}" font-size="26" font-weight="600" letter-spacing="1" fill="${BRAND}">jsonl-tools.dev</text>
</svg>
`;
}

async function generate(): Promise<void> {
  const svg = buildOgCardSvg();

  // Puppeteer is imported here (not at module top) so importing this file for
  // buildOgCardSvg — as the test does — never spins up a browser.
  const puppeteer = (await import("puppeteer")).default as {
    launch: (opts: unknown) => Promise<{
      newPage: () => Promise<{
        setViewport: (v: unknown) => Promise<void>;
        setContent: (html: string, opts?: unknown) => Promise<void>;
        screenshot: (opts: unknown) => Promise<Uint8Array>;
      }>;
      close: () => Promise<void>;
    }>;
  };

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`,
      { waitUntil: "networkidle0" },
    );
    const png = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT },
    });
    await Bun.write("src/og.png", png);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  await generate();
  console.log(`wrote src/og.png (${OG_WIDTH}×${OG_HEIGHT})`);
}
