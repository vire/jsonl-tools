// Device-local "remember this unlock" store (design 2026-06-04).
//
// Persists the unlocked account key on THIS device so a returning signed-in user
// skips the passphrase prompt, until they sign out or forget the device. The key
// is wrapped under a fresh NON-EXTRACTABLE AES-GCM device key kept in IndexedDB,
// so raw account-key bytes are never written in a JS-readable form. Entries are
// keyed by GitHub login so a shared browser never recalls another user's key.
// Client-only; no key material is sent to the server.

import { get, set, del } from "idb-keyval";
import { ACCOUNT_KEY_USAGES } from "./account-crypto";

const storeKey = (login: string) => `account-unlock:${login}`;

interface RememberedEntry {
  deviceKey: CryptoKey; // non-extractable AES-GCM wrapping key
  iv: Uint8Array;
  ct: Uint8Array; // account key wrapped under deviceKey
}

function getSubtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

/** Wrap `accountKey` under a fresh non-extractable device key and persist it. */
export async function rememberAccount(login: string, accountKey: CryptoKey): Promise<void> {
  const subtle = getSubtle();
  if (!subtle) return; // insecure context → skip; the user re-enters the passphrase
  try {
    const deviceKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.wrapKey("raw", accountKey, deviceKey, { name: "AES-GCM", iv });
    const entry: RememberedEntry = { deviceKey, iv, ct: new Uint8Array(wrapped) };
    await set(storeKey(login), entry);
  } catch {
    /* best-effort: never block unlock on a persistence failure */
  }
}

/** Recall the account key for `login`, or null if not remembered / unusable. */
export async function recallAccount(login: string): Promise<CryptoKey | null> {
  const subtle = getSubtle();
  if (!subtle) return null;
  let entry: RememberedEntry | undefined;
  try {
    entry = await get<RememberedEntry>(storeKey(login));
  } catch {
    return null;
  }
  if (!entry) return null;
  try {
    return await subtle.unwrapKey(
      "raw",
      entry.ct,
      entry.deviceKey,
      { name: "AES-GCM", iv: entry.iv },
      { name: "AES-GCM", length: 256 },
      false, // non-extractable: usable to wrap/unwrap content keys, never exported
      ACCOUNT_KEY_USAGES,
    );
  } catch {
    await forgetAccount(login); // corrupt / undecryptable → purge
    return null;
  }
}

/** Forget the remembered key for `login` (sign-out / "Forget this device"). */
export async function forgetAccount(login: string): Promise<void> {
  try {
    await del(storeKey(login));
  } catch {
    /* nothing to do */
  }
}

/** Whether a remembered entry exists for `login`. */
export async function isRemembered(login: string): Promise<boolean> {
  try {
    return (await get(storeKey(login))) !== undefined;
  } catch {
    return false;
  }
}
