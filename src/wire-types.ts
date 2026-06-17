// Shared client/server wire types (plan U1).
//
// TYPES ONLY — this module must never carry a runtime import. Importing it from
// a browser module can therefore never pull server code (or a secret) into the
// browser bundle. The boundary build-graph test enforces that server modules
// stay out of browser entries; keeping this file type-only keeps it safe to
// import from both sides.

export type ShareState = "active" | "expired" | "deleted" | "private";

/** POST body to create a share. `ciphertext`/`iv` come from share-crypto. */
export interface CreateShareRequest {
  /** client-generated 256-bit base64url id, bound into the content AAD */
  id: string;
  /** crypto format version */
  v: number;
  /** base64url IV */
  iv: string;
  /** base64url ciphertext (GCM tag appended) */
  ct: string;
  /** client-encrypted title; server cannot read it */
  encryptedTitle?: string | null;
  /** requested TTL in days; clamped server-side, capped for anonymous shares */
  expiresInDays?: number | null;
  /** Owned create only: store the entry as a private (unlisted) history entry —
   *  ciphertext is saved but `/s/<id>` does not resolve until toggled to active. */
  private?: boolean | null;
  /**
   * Present only on a logged-in create: the content key wrapped under the user's
   * account key. When supplied with a valid session, the share lands in durable
   * history. The server stores this blob; it cannot unwrap it.
   */
  wrappedContentKey?: { iv: string; ct: string } | null;
}

export interface CreateShareResponse {
  /** opaque, >=128-bit CSPRNG id (no embedded timestamp) */
  id: string;
  /** one-time admin token for logged-out delete; server stores only its hash */
  adminToken: string;
}

/** Successful fetch of an active share's ciphertext. The key is never here. */
export interface FetchShareResponse {
  v: number;
  iv: string;
  ct: string;
  encryptedTitle?: string | null;
}

/** Uniform opaque response for unknown / expired / deleted / not-yet-committed. */
export interface UnavailableResponse {
  error: "unavailable";
}

/** Transient failures the recipient must NOT interpret as "gone". */
export interface RetryableResponse {
  error: "temporarily_unavailable";
}

// --- @jsonl-tools/cli remote ingest (plan U2–U4) ---

/** A wrapped AES key blob — same shape used for content/machine keys. */
export interface WrappedKeyWire {
  iv: string;
  ct: string;
}

/** POST /api/cli/tokens — mint a per-box token (session-authed, account unlocked). */
export interface MintTokenRequest {
  /** human label for the box */
  label?: string | null;
  /** the box's machine key wrapped under the account key; server stores, cannot use */
  wrappedMachineKey: WrappedKeyWire;
}

/** The token secret is returned exactly once at mint time. */
export interface MintTokenResponse {
  /** non-secret lookup id, sent on every CLI request */
  tokenId: string;
  /** high-entropy secret half; shown once, never stored raw */
  authSecret: string;
}

/** One token in the list view (metadata + the wrapped machine key for decrypt). */
export interface CliTokenSummary {
  tokenId: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  /** account-wrapped machine key — needed by the web app to decrypt this box's uploads */
  wrappedMachineKey: WrappedKeyWire;
}

export interface ListTokensResponse {
  tokens: CliTokenSummary[];
}

/** POST /api/cli/uploads — token-authed, zero-knowledge upload (Bearer). */
export interface CliUploadRequest {
  /** client-generated 256-bit base64url id, bound into the content AAD */
  id: string;
  v: number;
  iv: string;
  ct: string;
  /** client-encrypted title; server cannot read it */
  encryptedTitle?: string | null;
  /** content key wrapped under the box's machine key */
  wrappedContentKey: WrappedKeyWire;
}

export interface CliUploadResponse {
  id: string;
}

/** One upload in the CLI list view. */
export interface CliUploadSummary {
  shareId: string;
  encryptedTitle: string | null;
  sizeBytes: number;
  createdAt: string;
  state: ShareState;
  /** content key wrapped under the box's machine key */
  wrappedContentKey: WrappedKeyWire;
}

export interface CliListResponse {
  items: CliUploadSummary[];
}
