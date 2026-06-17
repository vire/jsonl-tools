// Browser client for the share API (plan U3).
//
// Orchestrates the zero-knowledge create flow: generate id + content key,
// encrypt client-side, upload only ciphertext, and assemble the link with the
// key in the fragment. This module never sends plaintext or the key to the
// server, and it must only run on an analytics-free surface (R22).

import {
  generateShareId,
  generateContentKey,
  encryptSession,
  exportKeyToFragment,
} from "./share-crypto";
import { fetchWithSession } from "./session-id";
import type { CreateShareRequest, CreateShareResponse } from "./wire-types";

export interface CreatedShare {
  id: string;
  /** full shareable link including the `#key` fragment */
  link: string;
  /** one-time admin token for logged-out delete (server stores only its hash) */
  adminToken: string;
  /** the content key, for the device-local store */
  contentKey: CryptoKey;
}

export interface CreateShareOptions {
  encryptedTitle?: string | null;
  expiresInDays?: number | null;
  /** link origin; defaults to location.origin in the browser */
  origin?: string;
}

export async function createShare(
  session: string,
  opts: CreateShareOptions = {},
): Promise<CreatedShare> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession(session, key, id);

  const body: CreateShareRequest = {
    id,
    v: env.v,
    iv: env.iv,
    ct: env.ct,
    encryptedTitle: opts.encryptedTitle ?? null,
    expiresInDays: opts.expiresInDays ?? null,
  };

  const res = await fetchWithSession(
    "/api/shares",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    "home",
  );
  if (!res.ok) {
    throw new Error(`Failed to create share (HTTP ${res.status}).`);
  }
  const { adminToken } = (await res.json()) as CreateShareResponse;

  // The key is exported into the fragment only — it never leaves this device
  // except in the link the user chooses to share.
  const fragment = await exportKeyToFragment(key);
  const origin =
    opts.origin ?? (typeof location !== "undefined" ? location.origin : "");
  const link = `${origin}/s/${id}#key=${fragment}`;

  return { id, link, adminToken, contentKey: key };
}

/**
 * Revoke (delete) a share with its per-share admin token. The server tombstones
 * the row and nulls the ciphertext, so the link stops resolving — the operation
 * is destructive and idempotent. Used by the share toggle's "un-share" path.
 */
export async function revokeShare(id: string, adminToken: string): Promise<void> {
  const res = await fetchWithSession(
    `/api/shares/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { "x-admin-token": adminToken },
    },
    "home",
  );
  if (!res.ok) {
    throw new Error(`Failed to revoke share (HTTP ${res.status}).`);
  }
}
