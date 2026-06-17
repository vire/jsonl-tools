// Browser orchestration for accounts + durable history (plan U8–U10).
//
// Ties account-crypto to the API: setup/unlock/recover/rotate the account key,
// create a share that also lands in history, decrypt history, and reconcile
// device-local shares. All key material stays client-side; only wrapped blobs
// and ciphertext leave the browser. Must run on an analytics-free surface (R22).

import {
  setupAccount,
  unlockWithPassphrase,
  unlockWithRecovery,
  rotatePassphrase,
  deriveAuthTag,
  deriveRecoveryAuthTag,
  wrapContentKey,
  unwrapContentKey,
  generateMachineKey,
  exportMachineKeyRaw,
  wrapMachineKey,
  unwrapMachineKey,
  type AccountBlobs,
  type WrappedKey,
} from "./account-crypto";
import { encodeCredential, type CliCredential } from "./cli-credential";
import type { ListTokensResponse, CliTokenSummary } from "./wire-types";
import {
  generateShareId,
  generateContentKey,
  encryptSession,
  decryptSession,
  exportKeyToFragment,
  importKeyFromFragment,
  type ShareEnvelope,
} from "./share-crypto";
import type { CreatedShare } from "./api-client";
import { surfaceFetch } from "./session-id";

// Account + history flows all run on the home surface; their default fetch tags
// /api/* calls with the home session id + surface label (R22-safe, URL-blind).
const homeFetch = surfaceFetch("home");

export class NoAccountError extends Error {}

export interface UnlockedAccount {
  accountKey: CryptoKey;
  authTag: string;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** First-time setup: returns the recovery code (show once) + the unlocked account. */
export async function setupAccountFlow(
  passphrase: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<{ recoveryCode: string; account: UnlockedAccount }> {
  const s = await setupAccount(passphrase);
  const res = await fetchImpl(
    "/api/account",
    post({ blobs: s.blobs, authTag: s.authTag, recoveryAuthTag: s.recoveryAuthTag }),
  );
  if (!res.ok) throw new Error(`Account setup failed (HTTP ${res.status}).`);
  return {
    recoveryCode: s.recoveryCode,
    account: { accountKey: s.accountKey, authTag: s.authTag },
  };
}

/** Unlock the account on this device with the passphrase. */
export async function unlockAccountFlow(
  passphrase: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<UnlockedAccount> {
  const res = await fetchImpl("/api/account");
  if (res.status === 404) throw new NoAccountError();
  if (!res.ok) throw new Error(`Could not load account (HTTP ${res.status}).`);
  const { kdf, wrappedUnderMaster, verifier } = await res.json();
  if (!kdf || !wrappedUnderMaster || !verifier) {
    // Defensive: a malformed/empty payload would otherwise crash deep in the KDF
    // with a cryptic "reading 'iterations'" TypeError.
    throw new Error("Couldn't load your account data — please reload and try again.");
  }
  const blobs: AccountBlobs = {
    kdf,
    wrappedUnderMaster,
    verifier,
    wrappedUnderRecovery: { iv: "", ct: "" }, // not needed for passphrase unlock
  };
  const accountKey = await unlockWithPassphrase(passphrase, blobs);
  return { accountKey, authTag: await deriveAuthTag(passphrase, kdf) };
}

/**
 * Verify a recovery code by unlocking the account key with it — a read-only check
 * with no server write. Returns the unlocked account key so a later rotation can
 * reuse it without re-fetching. Throws if the code is malformed or doesn't match
 * the account; the UI uses this to gate the new-passphrase step behind an
 * accepted code.
 */
export async function verifyRecoveryCode(
  recoveryCode: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<CryptoKey> {
  const accRes = await fetchImpl("/api/account");
  if (!accRes.ok) throw new Error(`Could not load account (HTTP ${accRes.status}).`);
  const { kdf, wrappedUnderMaster, verifier } = await accRes.json();
  const recRes = await fetchImpl("/api/account/recovery");
  if (!recRes.ok) throw new Error(`Could not load recovery data (HTTP ${recRes.status}).`);
  const { wrappedUnderRecovery } = await recRes.json();

  return unlockWithRecovery(recoveryCode, {
    kdf,
    wrappedUnderMaster,
    verifier,
    wrappedUnderRecovery,
  });
}

/**
 * Set a new passphrase after the recovery code has been verified. Rotates the
 * SAME account key under the new passphrase + a fresh recovery code, authorized
 * by the recovery-code proof token. Returns the new recovery code (show once).
 */
export async function rotateAfterRecovery(
  recoveryCode: string,
  accountKey: CryptoKey,
  newPassphrase: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<{ recoveryCode: string; account: UnlockedAccount }> {
  const rotated = await rotatePassphrase(newPassphrase, accountKey);
  const res = await fetchImpl(
    "/api/account/rotate",
    post({
      blobs: rotated.blobs,
      authTag: rotated.authTag,
      recoveryAuthTag: rotated.recoveryAuthTag,
      currentAuthTag: await deriveRecoveryAuthTag(recoveryCode),
    }),
  );
  if (!res.ok) throw new Error(`Recovery rotation failed (HTTP ${res.status}).`);
  return {
    recoveryCode: rotated.recoveryCode,
    account: { accountKey, authTag: rotated.authTag },
  };
}

/** Lost passphrase: verify the recovery code, then set a new passphrase. */
export async function recoverAccountFlow(
  recoveryCode: string,
  newPassphrase: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<{ recoveryCode: string; account: UnlockedAccount }> {
  const accountKey = await verifyRecoveryCode(recoveryCode, fetchImpl);
  return rotateAfterRecovery(recoveryCode, accountKey, newPassphrase, fetchImpl);
}

/** Change the passphrase (knowing the current one). */
export async function rotatePassphraseFlow(
  currentPassphrase: string,
  newPassphrase: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<{ recoveryCode: string; account: UnlockedAccount }> {
  const current = await unlockAccountFlow(currentPassphrase, fetchImpl);
  const rotated = await rotatePassphrase(newPassphrase, current.accountKey);
  const res = await fetchImpl(
    "/api/account/rotate",
    post({
      blobs: rotated.blobs,
      authTag: rotated.authTag,
      recoveryAuthTag: rotated.recoveryAuthTag,
      currentAuthTag: current.authTag,
    }),
  );
  if (!res.ok) throw new Error(`Passphrase change failed (HTTP ${res.status}).`);
  return {
    recoveryCode: rotated.recoveryCode,
    account: { accountKey: current.accountKey, authTag: rotated.authTag },
  };
}

/** Create a share that also lands in durable history (logged-in + unlocked). */
export async function createSharedToHistory(
  session: string,
  accountKey: CryptoKey,
  opts: { title?: string; expiresInDays?: number | null; origin?: string } = {},
  fetchImpl: typeof fetch = homeFetch,
): Promise<CreatedShare> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession(session, key, id);
  const wrappedContentKey = await wrapContentKey(accountKey, key);
  const encryptedTitle = opts.title
    ? JSON.stringify(await encryptSession(opts.title, key, id))
    : null;

  const res = await fetchImpl(
    "/api/shares",
    post({
      id,
      v: env.v,
      iv: env.iv,
      ct: env.ct,
      encryptedTitle,
      expiresInDays: opts.expiresInDays ?? null,
      wrappedContentKey,
    }),
  );
  if (!res.ok) throw new Error(`Create failed (HTTP ${res.status}).`);
  const { adminToken } = await res.json();
  const fragment = await exportKeyToFragment(key);
  const origin =
    opts.origin ?? (typeof location !== "undefined" ? location.origin : "");
  return { id, link: `${origin}/s/${id}#key=${fragment}`, adminToken, contentKey: key };
}

/**
 * Save a session to durable history as a PRIVATE (unlisted) entry: encrypt under a
 * fresh content key, wrap that key under the account key, and upload ciphertext the
 * server cannot read. The entry does not resolve via `/s/<id>` until toggled to
 * `active` (setHistoryShareState). Returns the id + the openable key fragment.
 */
export async function saveToHistory(
  session: string,
  accountKey: CryptoKey,
  opts: { title?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; keyFragment: string }> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession(session, key, id);
  const wrappedContentKey = await wrapContentKey(accountKey, key);
  const encryptedTitle = opts.title
    ? JSON.stringify(await encryptSession(opts.title, key, id))
    : null;

  const res = await fetchImpl(
    "/api/shares",
    post({ id, v: env.v, iv: env.iv, ct: env.ct, encryptedTitle, private: true, wrappedContentKey }),
  );
  if (!res.ok) throw new Error(`Save failed (HTTP ${res.status}).`);
  return { id, keyFragment: await exportKeyToFragment(key) };
}

export interface DecryptedHistoryItem {
  shareId: string;
  title: string | null;
  /** base64url content key for the `#key=` fragment, so the openable link can be
   *  rebuilt client-side; null when the content key couldn't be unwrapped. */
  keyFragment: string | null;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
  state: string;
}

/**
 * Fetch history and decrypt titles client-side (after unlock). Web shares decrypt
 * under the account key directly; CLI uploads (cli_token_id set) decrypt under the
 * box's machine key, which is itself unwrapped under the account key — once per
 * distinct token, cached. A machine key that fails to unwrap (revoked-and-garbled
 * or absent) leaves only its own items undecrypted; everything else still renders.
 */
export async function fetchHistoryDecrypted(
  accountKey: CryptoKey,
  fetchImpl: typeof fetch = homeFetch,
): Promise<DecryptedHistoryItem[]> {
  const res = await fetchImpl("/api/history");
  if (!res.ok) throw new Error(`Could not load history (HTTP ${res.status}).`);
  const { items } = (await res.json()) as { items: any[] };

  // Unwrap each machine key under the account key at most once per token id.
  const machineKeys = new Map<string, CryptoKey | null>();
  async function machineKeyFor(
    tokenId: string,
    wrapped: WrappedKey | null,
  ): Promise<CryptoKey | null> {
    if (machineKeys.has(tokenId)) return machineKeys.get(tokenId) ?? null;
    let mk: CryptoKey | null = null;
    try {
      if (wrapped) mk = await unwrapMachineKey(accountKey, wrapped);
    } catch {
      mk = null;
    }
    machineKeys.set(tokenId, mk);
    return mk;
  }

  const out: DecryptedHistoryItem[] = [];
  for (const it of items) {
    let title: string | null = null;
    let keyFragment: string | null = null;
    try {
      let contentKey: CryptoKey;
      if (it.cliTokenId) {
        const mk = await machineKeyFor(it.cliTokenId, it.wrappedMachineKey ?? null);
        if (!mk) throw new Error("machine key unavailable");
        contentKey = await unwrapContentKey(mk, it.wrappedContentKey);
      } else {
        contentKey = await unwrapContentKey(accountKey, it.wrappedContentKey);
      }
      // Re-export the key into the same fragment the share link uses, so the
      // History panel can rebuild an openable link (the key never left the client).
      keyFragment = await exportKeyToFragment(contentKey);
      if (it.encryptedTitle) {
        title = await decryptSession(
          JSON.parse(it.encryptedTitle) as ShareEnvelope,
          contentKey,
          it.shareId,
        );
      }
    } catch {
      /* leave title/keyFragment null if the content key can't be unwrapped */
    }
    out.push({
      shareId: it.shareId,
      title,
      keyFragment,
      sizeBytes: it.sizeBytes,
      createdAt: it.createdAt,
      expiresAt: it.expiresAt,
      state: it.state,
    });
  }
  return out;
}

// --- @jsonl-tools/cli token management (plan U5) ---

/** Display view of a CLI token — the wire summary minus the wrapped machine key. */
export type CliTokenView = Omit<CliTokenSummary, "wrappedMachineKey">;

/**
 * Mint a per-box CLI token (account unlocked). Generates a machine key, wraps it
 * under the account key for server storage, and returns the one-time credential
 * string (token id + auth secret + raw machine key) to show the operator once.
 * The raw machine key never leaves the client except inside that credential.
 */
export async function mintCliTokenFlow(
  accountKey: CryptoKey,
  label: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<{ credential: string; tokenId: string }> {
  const machineKey = await generateMachineKey();
  const wrappedMachineKey = await wrapMachineKey(accountKey, machineKey);
  const res = await fetchImpl("/api/cli/tokens", post({ label, wrappedMachineKey }));
  if (!res.ok) throw new Error(`Token mint failed (HTTP ${res.status}).`);
  const { tokenId, authSecret } = (await res.json()) as {
    tokenId: string;
    authSecret: string;
  };
  const cred: CliCredential = {
    tokenId,
    authSecret,
    machineKey: await exportMachineKeyRaw(machineKey),
  };
  return { credential: encodeCredential(cred), tokenId };
}

/** List the account's CLI tokens (metadata only for display). */
export async function listCliTokens(
  fetchImpl: typeof fetch = homeFetch,
): Promise<CliTokenView[]> {
  const res = await fetchImpl("/api/cli/tokens");
  if (!res.ok) throw new Error(`Could not load tokens (HTTP ${res.status}).`);
  const { tokens } = (await res.json()) as ListTokensResponse;
  return tokens.map(({ wrappedMachineKey, ...view }) => view);
}

/** Revoke a CLI token by id (stops new uploads from that box). */
export async function revokeCliToken(
  tokenId: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<void> {
  const res = await fetchImpl(`/api/cli/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`Revoke failed (HTTP ${res.status}).`);
}

/** Reconcile one device-local share into durable history (server write, then mark imported). */
export async function reconcileLocalShare(
  shareId: string,
  contentKey: CryptoKey,
  accountKey: CryptoKey,
  fetchImpl: typeof fetch = homeFetch,
): Promise<boolean> {
  const wrappedContentKey = await wrapContentKey(accountKey, contentKey);
  const res = await fetchImpl("/api/reconcile", post({ shareId, wrappedContentKey }));
  return res.ok;
}

/**
 * Remove one entry from durable history. This deletes only the user's
 * history_keys row (its wrapped content key) — the share itself, its ciphertext,
 * and any recipient `/s/<id>` link are untouched.
 */
export async function deleteHistoryEntry(
  shareId: string,
  fetchImpl: typeof fetch = homeFetch,
): Promise<void> {
  const res = await fetchImpl(`/api/history/${encodeURIComponent(shareId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Could not remove from history (HTTP ${res.status}).`);
}

/** Toggle an owned history entry's share state: 'active' (link resolves) or 'private' (hidden). */
export async function setHistoryShareState(
  shareId: string,
  state: "active" | "private",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`/api/history/${encodeURIComponent(shareId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`Could not update sharing (HTTP ${res.status}).`);
}

/**
 * Rename an owned history entry. Re-encrypts the new title under the entry's content
 * key — re-imported from the openable `keyFragment` (the server never sees the key)
 * — and PATCHes the new encrypted title. AAD binds the share id, matching create.
 */
export async function renameHistoryEntry(
  shareId: string,
  keyFragment: string,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = await importKeyFromFragment(keyFragment);
  const encryptedTitle = JSON.stringify(await encryptSession(title, key, shareId));
  const res = await fetchImpl(`/api/history/${encodeURIComponent(shareId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encryptedTitle }),
  });
  if (!res.ok) throw new Error(`Rename failed (HTTP ${res.status}).`);
}
