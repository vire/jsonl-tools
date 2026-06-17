// Device-local "recent shares" store (plan U3, R10).
//
// Browser-only. Holds the content key, admin token, and link for shares created
// on THIS device — a best-effort list that is lost when browser storage clears.
// IndexedDB is not encrypted at rest, so this is an acknowledged XSS surface
// (mitigated by the strict CSP and the no-third-party-script rule). The content
// key must be extractable (it is exported into the fragment), so it is stored as
// a structured-clonable CryptoKey rather than a non-extractable handle.

import { set, del, entries } from "idb-keyval";

const PREFIX = "share:";

export interface LocalShare {
  id: string;
  link: string;
  adminToken: string;
  contentKey: CryptoKey;
  createdAt: number;
}

/** Persist a created share to this device's recent-shares list. */
export async function rememberShare(share: LocalShare): Promise<void> {
  await set(PREFIX + share.id, share);
}

/** List this device's shares, newest first. */
export async function listLocalShares(): Promise<LocalShare[]> {
  const all = await entries<string, LocalShare>();
  return all
    .filter(([key]) => typeof key === "string" && key.startsWith(PREFIX))
    .map(([, value]) => value)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Drop a share from the local list (e.g. after deleting it server-side). */
export async function forgetShare(id: string): Promise<void> {
  await del(PREFIX + id);
}
