// Pure viewer logic (plan U4), separated from the React/CSS module so it is
// unit-testable under `bun test` without a DOM or a bundler.

import {
  importKeyFromFragment,
  decryptSession,
  type ShareEnvelope,
} from "./share-crypto";
import { surfaceFetch } from "./session-id";

// The viewer's default fetch tags /api/* calls with the "viewer" surface label
// only — the key-bearing viewer is never issued a session id (KTD3/KTD5). This
// is what makes the GET /api/shares/:id on load count as a viewer page-view.
const viewerFetch = surfaceFetch("viewer");

export interface ShareLocation {
  id: string;
  key: string;
}

/** Extract a valid share id from the pathname, ignoring any `#fragment`. */
export function parseShareId(pathname: string): string | null {
  const m = pathname.match(/^\/s\/([A-Za-z0-9_-]{43})\/?$/);
  return m ? m[1]! : null;
}

/** Parse `/s/<id>` + `#key=<key>` into a location, or null if either is missing. */
export function parseShareLocation(
  pathname: string,
  hash: string,
): ShareLocation | null {
  const id = parseShareId(pathname);
  if (!id) return null;
  const key = new URLSearchParams(hash.replace(/^#/, "")).get("key");
  if (!key) return null;
  return { id, key };
}

export type ViewerState =
  | { status: "loading" }
  | { status: "ready"; plaintext: string }
  | { status: "no-key" }
  | { status: "unavailable" }
  | { status: "retry" }
  | { status: "decrypt-failed" }
  | { status: "insecure" };

/**
 * Fetch and decrypt a share. Distinguishes the opaque terminal "unavailable"
 * (404) from a retryable transient error, and a decryption failure (wrong key /
 * tampered / wrong link) from both. Returns the decrypted plaintext; the caller
 * renders it.
 */
export async function loadShare(
  loc: ShareLocation,
  fetchImpl: typeof fetch = viewerFetch,
): Promise<ViewerState> {
  let env: ShareEnvelope;
  try {
    const res = await fetchImpl(`/api/shares/${loc.id}`);
    if (res.status === 404) return { status: "unavailable" };
    if (!res.ok) return { status: "retry" };
    env = (await res.json()) as ShareEnvelope;
  } catch {
    return { status: "retry" };
  }

  try {
    const key = await importKeyFromFragment(loc.key);
    const plaintext = await decryptSession(env, key, loc.id);
    return { status: "ready", plaintext };
  } catch {
    return { status: "decrypt-failed" };
  }
}

/**
 * Return-visit path: the URL carries no `#key`, so recall a key saved on this
 * device for the path's share id and decrypt with it. A 404 (the share expired
 * or was deleted) purges the now-dead local key via `forget`. Returns `no-key`
 * when the path is not a share or nothing was remembered. Deps are injected for
 * testability; in the app they are the `share-remember` functions and `fetch`.
 */
export async function loadRemembered(
  pathname: string,
  recall: (id: string) => Promise<string | null>,
  forget: (id: string) => Promise<void>,
  fetchImpl: typeof fetch = viewerFetch,
): Promise<ViewerState> {
  const id = parseShareId(pathname);
  if (!id) return { status: "no-key" };
  const key = await recall(id);
  if (!key) return { status: "no-key" };
  const state = await loadShare({ id, key }, fetchImpl);
  if (state.status === "unavailable") await forget(id);
  return state;
}
