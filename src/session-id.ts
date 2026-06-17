// Cookieless, per-surface session id + a fetch wrapper that tags first-party
// /api/* calls (plan U4).
//
// R22 / KTD3: this module is imported by the key-bearing home and viewer
// surfaces, so it stays URL-blind — it reads ONLY sessionStorage, crypto, and
// the outgoing request. It never inspects any page-URL or navigation state, and
// it adds only two headers (X-Anon-Session, X-Anon-Surface). The boundary test
// enforces both properties on this file's source.

export type Surface = "home" | "viewer" | "bulk-analyzer";

// Surfaces that are issued a session id. Only the home/create surface carries
// one (distinct-visit counts for the share-create flow). The "/s/:id" viewer and
// the bulk-analyzer are deliberately excluded — they carry the surface label
// only and are never assigned an id, so neither can be correlated at session
// grain (KTD5). New session surfaces go here, not at call sites.
const SESSION_SURFACES = new Set<Surface>(["home"]);

// Per-surface sessionStorage key, so an id is never shared across surfaces.
const STORAGE_KEY: Partial<Record<Surface, string>> = {
  home: "anon-session-home",
};

/** sessionStorage if available (absent under bun test / SSR), else undefined. */
function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage as Storage | undefined;
  } catch {
    return undefined; // access can throw in sandboxed/blocked contexts
  }
}

/**
 * The stable per-session id for `surface`, lazily minted on first use. Returns
 * `undefined` for any non-session surface (viewer, bulk-analyzer) and whenever
 * sessionStorage is unavailable — callers treat `undefined` as "send no session
 * header". Never throws.
 */
export function getSessionId(surface: Surface): string | undefined {
  if (!SESSION_SURFACES.has(surface)) return undefined; // viewer/bulk: no id, no storage touch
  const key = STORAGE_KEY[surface];
  if (!key) return undefined;
  const s = store();
  if (!s) return undefined;
  try {
    let id = s.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      s.setItem(key, id);
    }
    return id;
  } catch {
    return undefined; // storage disabled (private mode / quota) — degrade quietly
  }
}

/** A relative same-origin /api/* path is the only thing we tag. */
function isTaggablePath(input: RequestInfo | URL): boolean {
  // Only a path-relative "/api/..." string is same-origin by construction.
  // Absolute URLs / Request objects would require comparing origins (which
  // needs page-URL state we refuse to read here), so they are never tagged.
  return typeof input === "string" && input.startsWith("/api/");
}

/**
 * `fetch`, with the anon session id (when the surface has one) and the surface
 * label attached — but ONLY to relative same-origin /api/* requests. Any other
 * target (cross-origin, data:, blob:, a Request/URL object) is delegated to
 * `fetch` untouched. Drop-in replacement for `fetch` once a surface is bound;
 * see `surfaceFetch`.
 */
export function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  surface: Surface,
): Promise<Response> {
  if (!isTaggablePath(input)) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("X-Anon-Surface", surface);
  const id = getSessionId(surface);
  if (id) headers.set("X-Anon-Session", id);
  return fetch(input, { ...init, headers });
}

/** Bind a surface to get a `typeof fetch`, for modules with an injectable fetchImpl. */
export function surfaceFetch(surface: Surface): typeof fetch {
  return (input, init) => fetchWithSession(input, init, surface);
}
