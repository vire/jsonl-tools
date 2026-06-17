// Brand asset generator for jsonl-tools (run: `bun scripts/gen-brand.ts`).
//
// Emits three self-contained SVGs to src/:
//   favicon.svg — cog only, purple, transparent hole (clean to 16px)
//   mark.svg    — { cog } : neutral braces + purple cog
//   logo.svg    — { cog } jsonl-tools : the full 2-color wordmark lockup
//
// One brand hue (lavender/violet) + one neutral that flips per light/dark via an
// inline prefers-color-scheme rule, so a single file works on any background. The
// cog geometry is computed (rounded gear teeth + a real round hole via fill-rule),
// so the marks stay crisp at any size instead of being a traced bitmap.

export const BRAND = "#9b86f5"; // cog + "-tools" — aligned to the app's link lavender
export const NEUTRAL_LIGHT_BG = "#0d1421"; // braces + "jsonl" on a light background
export const NEUTRAL_DARK_BG = "#e8edf6"; // …and on a dark background

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A gear with rounded tooth tips + a concentric round hole (transparent via
 *  evenodd). Each tooth rises from the root radius to the tip with a quadratic
 *  curve, sits flat across the tip, then falls back — the softer, modern read. */
export function cogPath(
  cx: number,
  cy: number,
  ro: number, // tooth-tip radius
  rr: number, // root radius (between teeth)
  rh: number, // hub-hole radius
  teeth = 8,
): string {
  const step = (Math.PI * 2) / teeth;
  // Per-tooth period fractions: [rise start, tip start, tip end, fall end].
  const f = [0.18, 0.32, 0.68, 0.82] as const;
  const pt = (a: number, r: number): [number, number] => [
    r2(cx + r * Math.cos(a)),
    r2(cy + r * Math.sin(a)),
  ];
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2; // start at 12 o'clock
    const p0 = pt(a + step * f[0], rr); // root, before the tooth
    const t0 = pt(a + step * f[0], ro); // control: round the leading tip
    const p1 = pt(a + step * f[1], ro); // tip start
    const p2 = pt(a + step * f[2], ro); // tip end
    const t3 = pt(a + step * f[3], ro); // control: round the trailing tip
    const p3 = pt(a + step * f[3], rr); // root, after the tooth
    d += `${i === 0 ? "M" : "L"}${p0[0]} ${p0[1]}`;
    d += ` Q${t0[0]} ${t0[1]} ${p1[0]} ${p1[1]}`;
    d += ` L${p2[0]} ${p2[1]}`;
    d += ` Q${t3[0]} ${t3[1]} ${p3[0]} ${p3[1]}`;
  }
  d += " Z ";
  // Hole as two semicircular arcs, opposite winding handled by evenodd.
  d += `M${r2(cx - rh)} ${r2(cy)} a${rh} ${rh} 0 1 0 ${r2(rh * 2)} 0 a${rh} ${rh} 0 1 0 ${r2(-rh * 2)} 0 Z`;
  return d;
}

/** A curly brace as a stroked path; `side` aims the nub left or right. */
export function bracePath(
  side: "left" | "right",
  xTip: number,
  ty: number,
  h: number,
  reach: number,
): string {
  const dir = side === "left" ? -1 : 1;
  const xMid = xTip + dir * reach * 0.5;
  const xNub = xTip + dir * reach;
  const xPull = xTip + dir * reach * 0.55;
  const xInner = xMid + dir * reach * 0.3;
  const y = (f: number) => r2(ty + h * f);
  return [
    `M${r2(xTip)} ${r2(ty)}`,
    `C${r2(xPull)} ${r2(ty)} ${r2(xMid)} ${r2(ty)} ${r2(xMid)} ${y(0.16)}`,
    `L${r2(xMid)} ${y(0.42)}`,
    `C${r2(xMid)} ${y(0.48)} ${r2(xInner)} ${y(0.5)} ${r2(xNub)} ${y(0.5)}`,
    `C${r2(xInner)} ${y(0.5)} ${r2(xMid)} ${y(0.52)} ${r2(xMid)} ${y(0.58)}`,
    `L${r2(xMid)} ${y(0.84)}`,
    `C${r2(xMid)} ${y(1)} ${r2(xPull)} ${y(1)} ${r2(xTip)} ${y(1)}`,
  ].join(" ");
}

const styleBlock = (braceWidth: number) => `
  <style>
    .cog { fill: ${BRAND}; }
    .brand { fill: ${BRAND}; }
    .neutral { fill: ${NEUTRAL_LIGHT_BG}; }
    .brace {
      fill: none;
      stroke: ${NEUTRAL_LIGHT_BG};
      stroke-width: ${braceWidth};
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    @media (prefers-color-scheme: dark) {
      .neutral { fill: ${NEUTRAL_DARK_BG}; }
      .brace { stroke: ${NEUTRAL_DARK_BG}; }
    }
  </style>`;

// ── favicon.svg — cog only ────────────────────────────────────────────────
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="jsonl-tools">
  <style>.cog { fill: ${BRAND}; }</style>
  <path class="cog" fill-rule="evenodd" d="${cogPath(32, 32, 28, 20.5, 9.5)}"/>
</svg>
`;

// ── mark.svg — { cog } ────────────────────────────────────────────────────
const markBraceW = 6;
const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="136" height="64" viewBox="0 0 136 64" role="img" aria-label="jsonl-tools">${styleBlock(markBraceW)}
  <path class="brace" d="${bracePath("left", 30, 8, 48, 18)}"/>
  <path class="cog" fill-rule="evenodd" d="${cogPath(68, 32, 26, 19, 9)}"/>
  <path class="brace" d="${bracePath("right", 106, 8, 48, 18)}"/>
</svg>
`;

// ── logo.svg — { cog } jsonl-tools ────────────────────────────────────────
const logoBraceW = 5.5;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="372" height="64" viewBox="0 0 372 64" role="img" aria-label="jsonl-tools">${styleBlock(logoBraceW)}
  <path class="brace" d="${bracePath("left", 26, 10, 44, 15)}"/>
  <path class="cog" fill-rule="evenodd" d="${cogPath(58, 32, 23, 17, 8)}"/>
  <path class="brace" d="${bracePath("right", 90, 10, 44, 15)}"/>
  <text x="120" y="43" font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace" font-size="34" font-weight="700" letter-spacing="-0.5">
    <tspan class="neutral">jsonl</tspan><tspan class="brand">-tools</tspan>
  </text>
</svg>
`;

if (import.meta.main) {
  await Bun.write("src/favicon.svg", favicon);
  await Bun.write("src/mark.svg", mark);
  await Bun.write("src/logo.svg", logo);
  console.log("wrote src/favicon.svg, src/mark.svg, src/logo.svg");
}
