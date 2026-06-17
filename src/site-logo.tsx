// Header brand lockup — the `{ ⚙ } jsonl-tools` wordmark, styled by `.site-logo`
// in index.css. Inlined (rather than the adaptive logo.svg) so the wordmark
// always renders against the forced-dark background and follows the theme
// tokens. Geometry mirrors gen-brand.ts's rounded-tooth gear (concept R1) — keep
// the two in sync if you change tooth count or proportions (see DESIGN.md).
//
// Lives in its own dependency-free module so both the main app (App.tsx) and the
// analytics-free recipient viewer (share-viewer.tsx) can share one copy of the
// gear geometry without the viewer pulling in App.tsx's heavier imports.

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

export function SiteLogo() {
  return (
    <span className="site-logo">
      <span className="site-logo__mark">
        <span className="site-logo__brace">{"{"}</span>
        <svg
          className="site-logo__gear"
          viewBox="0 0 100 100"
          aria-hidden="true"
          focusable="false"
        >
          <mask id="site-logo-hole">
            <rect x="0" y="0" width="100" height="100" fill="white" />
            <circle cx="50" cy="50" r="17" fill="black" />
          </mask>
          <path d={GEAR_PATH} fill="currentColor" mask="url(#site-logo-hole)" />
        </svg>
        <span className="site-logo__brace">{"}"}</span>
      </span>
      <span className="site-logo__word">
        jsonl<span className="site-logo__tools">-tools</span>
      </span>
    </span>
  );
}

export default SiteLogo;
