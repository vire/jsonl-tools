// Device-local recall of a *received* share's content key (design 2026-06-04).
//
// When a recipient successfully decrypts `/s/<id>#key=<key>`, the key fragment is
// persisted here so they can re-open the bare `/s/<id>` later WITHOUT the original
// link. Browser-only. Stores the raw base64url key string in IndexedDB — the same
// acknowledged at-rest XSS posture as local-store.ts (mitigated by the strict CSP
// and the no-third-party-script rule). The key never leaves this device and never
// re-enters the URL. Every operation is best-effort: a storage failure degrades to
// "link required", never a broken viewer.

import { get, set, del } from "idb-keyval";

const PREFIX = "view:";
const storeKey = (id: string) => PREFIX + id;

/**
 * Persist the content-key fragment for a successfully decrypted share. Returns
 * whether the write landed (false if storage is unavailable/blocked), so the UI
 * can show an accurate "saved on this device" state rather than assuming success.
 */
export async function rememberShareKey(
  id: string,
  keyFragment: string,
): Promise<boolean> {
  try {
    await set(storeKey(id), keyFragment);
    return true;
  } catch {
    return false; // best-effort: never block the viewer on a persistence failure
  }
}

/** Recall the stored key fragment for `id`, or null if not remembered. */
export async function recallShareKey(id: string): Promise<string | null> {
  try {
    return (await get<string>(storeKey(id))) ?? null;
  } catch {
    return null;
  }
}

/** Forget the stored key for `id` (Forget control / purge a dead share). */
export async function forgetShareKey(id: string): Promise<void> {
  try {
    await del(storeKey(id));
  } catch {
    /* best-effort: ignore — a stale key causes no harm */
  }
}
