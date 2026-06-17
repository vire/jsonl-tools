// Browser-only zero-knowledge content encryption (plan U2).
//
// Each shared session is encrypted under its own random AES-256-GCM content
// key. The raw key is exported into the share link's URL fragment, so the
// server never sees it. The format version, algorithm, and the share id are
// bound into the GCM additional-authenticated-data (AAD) — a tampered envelope
// or a ciphertext served under a different id fails authentication rather than
// decrypting to garbage.

export const CRYPTO_VERSION = 1;
const ALG = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12;

/** Thrown when Web Crypto is unavailable (non-secure context / no HTTPS). */
export class SecureContextError extends Error {
  constructor(
    message = "Web Crypto (crypto.subtle) is unavailable — a secure context (HTTPS) is required.",
  ) {
    super(message);
    this.name = "SecureContextError";
  }
}

/** Thrown when decryption fails (wrong key, tampered ciphertext, or id mismatch). */
export class DecryptError extends Error {
  constructor(message = "Unable to decrypt — wrong key, tampered data, or wrong link.") {
    super(message);
    this.name = "DecryptError";
  }
}

/** The server-stored, server-unreadable envelope. The key lives only in the fragment. */
export interface ShareEnvelope {
  /** format version */
  v: number;
  /** base64url-encoded 12-byte IV */
  iv: string;
  /** base64url-encoded ciphertext (GCM tag appended) */
  ct: string;
}

/**
 * Returns the SubtleCrypto implementation or throws SecureContextError.
 * The parameter is injectable so the unavailable path is testable.
 */
export function assertCryptoAvailable(
  subtle: SubtleCrypto | null | undefined = globalThis.crypto?.subtle,
): SubtleCrypto {
  if (!subtle) throw new SecureContextError();
  return subtle;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The AAD binds the format version, algorithm, and share id into the
 * authentication tag. Serving this ciphertext under a different id, or with a
 * tampered version/algorithm, breaks decryption (substitution defense).
 */
function buildAad(shareId: string): Uint8Array {
  const canonical = JSON.stringify({ v: CRYPTO_VERSION, alg: "A256GCM", id: shareId });
  return new TextEncoder().encode(canonical);
}

/**
 * Generate an opaque 256-bit share id as a 43-char base64url string. The client
 * generates it (not the server) so it can be bound into the content AAD at
 * encrypt time; it carries no timestamp and the server enforces uniqueness.
 */
export function generateShareId(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Generate a fresh, extractable AES-256-GCM content key. */
export async function generateContentKey(): Promise<CryptoKey> {
  const subtle = assertCryptoAvailable();
  return subtle.generateKey({ name: ALG, length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Export the content key as a base64url string for placement in the URL fragment. */
export async function exportKeyToFragment(key: CryptoKey): Promise<string> {
  const subtle = assertCryptoAvailable();
  const raw = new Uint8Array(await subtle.exportKey("raw", key));
  return toBase64Url(raw);
}

/** Re-import a content key from its base64url fragment value. */
export async function importKeyFromFragment(fragment: string): Promise<CryptoKey> {
  const subtle = assertCryptoAvailable();
  return subtle.importKey("raw", fromBase64Url(fragment), { name: ALG }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a session string under `key`, binding `shareId` into the AAD. */
export async function encryptSession(
  plaintext: string,
  key: CryptoKey,
  shareId: string,
): Promise<ShareEnvelope> {
  const subtle = assertCryptoAvailable();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle.encrypt(
      { name: ALG, iv, additionalData: buildAad(shareId) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return { v: CRYPTO_VERSION, iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/** Decrypt an envelope under `key`, re-deriving the AAD from `shareId`. */
export async function decryptSession(
  env: ShareEnvelope,
  key: CryptoKey,
  shareId: string,
): Promise<string> {
  const subtle = assertCryptoAvailable();
  try {
    const plain = await subtle.decrypt(
      {
        name: ALG,
        iv: fromBase64Url(env.iv),
        additionalData: buildAad(shareId),
      },
      key,
      fromBase64Url(env.ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new DecryptError();
  }
}
