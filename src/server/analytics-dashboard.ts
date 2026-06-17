// Operator-gated usage dashboard (plan U5).
//
// Server-rendered HTML (no React, no client bundle) showing page-views per
// surface, distinct sessions per surface, and top API routes over a date range.
// Access is gated on the IMMUTABLE github_id (KTD6): a mutable login could be
// renamed/reclaimed, so the allowlist is keyed on the numeric id. Non-operators
// — logged in or not — get an identical bodyless 404, so the page's existence is
// never confirmed (AE4), mirroring handleMe's bodyless-401 idiom. This route is
// deliberately NOT wrapped by capture(), so the dashboard never measures itself.

import { getSql } from "./db";
import { userIdFromRequest } from "./sessions";

/** Allowlisted operator github_ids, parsed from a server-only env each call. */
function operatorIds(): Set<number> {
  const raw = process.env.OPERATOR_GITHUB_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// Surfaces that carry no session id by design (KTD3/KTD5), so their
// distinct-session figure is "n/a" rather than a misleading 0. Only the home
// surface is issued a session id.
const SESSIONLESS_SURFACES = new Set(["viewer", "bulk-analyzer"]);

/** A valid YYYY-MM-DD string, or null. */
function validDay(s: string | null): string | null {
  if (!s || !DAY_RE.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

/** Resolve the [from, to] day range from query params, defaulting to last 30d. */
function resolveRange(params: URLSearchParams): { from: string; to: string } {
  const now = new Date();
  const toDefault = now.toISOString().slice(0, 10);
  const fromDefault = new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10);
  let from = validDay(params.get("from")) ?? fromDefault;
  let to = validDay(params.get("to")) ?? toDefault;
  // Tolerate a reversed range (operator typo) rather than silently returning an
  // empty page. YYYY-MM-DD sorts lexicographically == chronologically.
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * GET /admin/analytics — operator-only usage dashboard. Bodyless 404 for anyone
 * who is not an allowlisted operator (logged out or not); a 200 HTML page
 * otherwise. Optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` bounds the range.
 */
export async function handleAnalyticsDashboard(req: Request): Promise<Response> {
  const notFound = () => new Response(null, { status: 404 });

  const sql = getSql();

  // Fail CLOSED: if we can't positively verify the requester is an operator —
  // including when the DB is unavailable mid-check — return the same opaque 404
  // a non-operator gets, never an error page that could differ observably.
  let githubId: number | null = null;
  try {
    const userId = await userIdFromRequest(req);
    if (userId === null) return notFound();
    const who = await sql`SELECT github_id FROM users WHERE id = ${userId}`;
    githubId = who[0]?.github_id != null ? Number(who[0].github_id) : null;
  } catch {
    return notFound();
  }
  if (githubId === null || !operatorIds().has(githubId)) return notFound();

  const { from, to } = resolveRange(new URL(req.url).searchParams);

  // Page-views + distinct sessions per surface, and top API routes by calls.
  const pageViews = await sql`
    SELECT surface, count(*)::int AS views
    FROM events
    WHERE kind = 'page_view' AND day BETWEEN ${from}::date AND ${to}::date
    GROUP BY surface
    ORDER BY views DESC
  `;
  const sessions = await sql`
    SELECT surface, count(DISTINCT session_id)::int AS sessions
    FROM events
    WHERE session_id IS NOT NULL AND day BETWEEN ${from}::date AND ${to}::date
    GROUP BY surface
  `;
  const routes = await sql`
    SELECT route, method, count(*)::int AS calls
    FROM events
    WHERE kind = 'api' AND day BETWEEN ${from}::date AND ${to}::date
    GROUP BY route, method
    ORDER BY calls DESC, route
    LIMIT 50
  `;

  const sessBySurface = new Map<string, number>(
    sessions.map((r: any) => [r.surface, r.sessions]),
  );
  const surfaceRows = pageViews
    .map((r: any) => {
      const sess = SESSIONLESS_SURFACES.has(r.surface)
        ? "n/a"
        : String(sessBySurface.get(r.surface) ?? 0);
      return `<tr><td>${esc(r.surface ?? "—")}</td><td>${r.views}</td><td>${sess}</td></tr>`;
    })
    .join("");
  const routeRows = routes
    .map(
      (r: any) =>
        `<tr><td>${esc(r.method ?? "—")}</td><td>${esc(r.route ?? "—")}</td><td>${r.calls}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Usage analytics</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#0d1421;background:#fff}
  h1{font-size:1.25rem} h2{font-size:1rem;margin-top:2rem}
  table{border-collapse:collapse;margin-top:.5rem;min-width:24rem}
  th,td{border:1px solid #d0d7de;padding:.35rem .6rem;text-align:left}
  th{background:#f6f8fa} td:last-child,th:last-child{text-align:right}
  .meta{color:#57606a}
</style></head><body>
<h1>Usage analytics</h1>
<p class="meta">First-party counts only — no IP, no identity, no file contents.
Range: ${esc(from)} → ${esc(to)} (use <code>?from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code>).</p>
<h2>Page-views by surface</h2>
<table><thead><tr><th>Surface</th><th>Page-views</th><th>Distinct sessions</th></tr></thead>
<tbody>${surfaceRows || `<tr><td colspan="3">No page-views in range.</td></tr>`}</tbody></table>
<h2>Top API routes</h2>
<table><thead><tr><th>Method</th><th>Route</th><th>Calls</th></tr></thead>
<tbody>${routeRows || `<tr><td colspan="3">No API calls in range.</td></tr>`}</tbody></table>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
