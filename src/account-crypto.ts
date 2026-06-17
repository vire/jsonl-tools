// Browser-only account key custody (plan U8).
//
// Hierarchy: passphrase --PBKDF2--> master key, which WRAPS a random account key.
// A second copy of the account key is wrapped under a key derived (HKDF) from a
// high-entropy recovery code. The server stores only the wrapped blobs + a
// verifier; it never sees the passphrase, master key, or account key. The
// account key's VALUE is immutable for the account's life — rotation/recovery
// only re-wrap it — so a content key wrapped under it on one device unwraps on
// another.

const VERIFIER_PLAINTEXT = "jsonl-tools/account-verify/v1";
const RECOVERY_INFO = "jsonl-tools/recovery/v1";
export const MIN_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;
const MIN_RECOVERY_BYTES = 16; // 128-bit

export interface WrappedKey {
  iv: string; // base64url
  ct: string; // base64url
}
export interface KdfParams {
  iterations: number;
  salt: string; // base64url
  hash: string;
  version: number;
}
export interface AccountBlobs {
  kdf: KdfParams;
  wrappedUnderMaster: WrappedKey;
  wrappedUnderRecovery: WrappedKey;
  verifier: WrappedKey;
}
export interface AccountSetup {
  blobs: AccountBlobs;
  recoveryCode: string;
  accountKey: CryptoKey;
  /** server-stored proof-of-passphrase token (not the master key) */
  authTag: string;
  /** server-stored proof-of-recovery-code token, authorizes rotation after recovery */
  recoveryAuthTag: string;
}

export class WrongPassphraseError extends Error {}
export class CorruptedBlobError extends Error {}
export class WeakPassphraseError extends Error {}
export class WeakRecoveryCodeError extends Error {}
export class KdfDowngradeError extends Error {}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Web Crypto unavailable — a secure context is required.");
  return s;
};

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 === 0 ? "" : "=".repeat(4 - (b.length % 4));
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
function kdfAad(kdf: KdfParams): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ i: kdf.iterations, s: kdf.salt, h: kdf.hash, v: kdf.version }),
  );
}

export const ACCOUNT_KEY_USAGES: KeyUsage[] = ["encrypt", "decrypt", "wrapKey", "unwrapKey"];

function assertKdfFloor(kdf: KdfParams): void {
  if (
    kdf.iterations < MIN_ITERATIONS ||
    kdf.hash !== "SHA-256" ||
    unb64(kdf.salt).length !== 16
  ) {
    throw new KdfDowngradeError("Server-supplied KDF parameters are below the floor.");
  }
}

async function deriveMasterKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  assertKdfFloor(kdf);
  const km = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt: unb64(kdf.salt), iterations: kdf.iterations, hash: kdf.hash },
    km,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
}

/**
 * A domain-separated value derived from the passphrase that the server stores
 * and compares on rotation to prove current-passphrase knowledge — without ever
 * learning the passphrase or master key. Same offline-crack risk class as the
 * verifier (mitigated by the iteration count + passphrase-strength floor).
 */
export async function deriveAuthTag(passphrase: string, kdf: KdfParams): Promise<string> {
  assertKdfFloor(kdf);
  const km = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const saltAuth = new Uint8Array([
    ...unb64(kdf.salt),
    ...new TextEncoder().encode("/auth"),
  ]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", salt: saltAuth, iterations: kdf.iterations, hash: kdf.hash },
    km,
    256,
  );
  return b64(new Uint8Array(bits));
}

export function generateRecoveryCode(): string {
  return b64(randomBytes(16)); // 128-bit
}

async function deriveRecoveryKey(code: string): Promise<CryptoKey> {
  if (unb64(code).length < MIN_RECOVERY_BYTES) {
    throw new WeakRecoveryCodeError("Recovery code has insufficient entropy.");
  }
  const km = await subtle().importKey("raw", unb64(code), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(RECOVERY_INFO),
    },
    km,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** A proof token derived from the recovery code, stored server-side to authorize
 *  a rotation when the passphrase was lost (the user can't present the pass auth tag). */
export async function deriveRecoveryAuthTag(code: string): Promise<string> {
  if (unb64(code).length < MIN_RECOVERY_BYTES) {
    throw new WeakRecoveryCodeError("Recovery code has insufficient entropy.");
  }
  const km = await subtle().importKey("raw", unb64(code), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("jsonl-tools/recovery-auth/v1"),
    },
    km,
    256,
  );
  return b64(new Uint8Array(bits));
}

async function generateAccountKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ACCOUNT_KEY_USAGES);
}

async function wrapUnder(wrappingKey: CryptoKey, key: CryptoKey): Promise<WrappedKey> {
  const iv = randomBytes(12);
  const wrapped = await subtle().wrapKey("raw", key, wrappingKey, { name: "AES-GCM", iv });
  return { iv: b64(iv), ct: b64(new Uint8Array(wrapped)) };
}

async function unwrapUnder(wrappingKey: CryptoKey, blob: WrappedKey): Promise<CryptoKey> {
  return subtle().unwrapKey(
    "raw",
    unb64(blob.ct),
    wrappingKey,
    { name: "AES-GCM", iv: unb64(blob.iv) },
    { name: "AES-GCM", length: 256 },
    true,
    ACCOUNT_KEY_USAGES,
  );
}

async function makeVerifier(masterKey: CryptoKey, kdf: KdfParams): Promise<WrappedKey> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: kdfAad(kdf) },
    masterKey,
    new TextEncoder().encode(VERIFIER_PLAINTEXT),
  );
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function verifierMatches(
  masterKey: CryptoKey,
  verifier: WrappedKey,
  kdf: KdfParams,
): Promise<boolean> {
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: unb64(verifier.iv), additionalData: kdfAad(kdf) },
      masterKey,
      unb64(verifier.ct),
    );
    return new TextDecoder().decode(pt) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

function assertPassphraseStrength(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphraseError(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
}

async function buildBlobs(
  passphrase: string,
  accountKey: CryptoKey,
): Promise<{
  blobs: AccountBlobs;
  recoveryCode: string;
  authTag: string;
  recoveryAuthTag: string;
}> {
  const kdf: KdfParams = {
    iterations: MIN_ITERATIONS,
    salt: b64(randomBytes(16)),
    hash: "SHA-256",
    version: 1,
  };
  const masterKey = await deriveMasterKey(passphrase, kdf);
  const recoveryCode = generateRecoveryCode();
  const recoveryKey = await deriveRecoveryKey(recoveryCode);
  return {
    blobs: {
      kdf,
      wrappedUnderMaster: await wrapUnder(masterKey, accountKey),
      wrappedUnderRecovery: await wrapUnder(recoveryKey, accountKey),
      verifier: await makeVerifier(masterKey, kdf),
    },
    recoveryCode,
    authTag: await deriveAuthTag(passphrase, kdf),
    recoveryAuthTag: await deriveRecoveryAuthTag(recoveryCode),
  };
}

/** First-time setup: generate the account key + recovery code and wrap both. */
export async function setupAccount(passphrase: string): Promise<AccountSetup> {
  assertPassphraseStrength(passphrase);
  const accountKey = await generateAccountKey();
  const built = await buildBlobs(passphrase, accountKey);
  return { ...built, accountKey };
}

/** Unlock the account key with the passphrase, distinguishing wrong-pass from corruption. */
export async function unlockWithPassphrase(
  passphrase: string,
  blobs: AccountBlobs,
): Promise<CryptoKey> {
  const masterKey = await deriveMasterKey(passphrase, blobs.kdf); // throws KdfDowngradeError
  if (!(await verifierMatches(masterKey, blobs.verifier, blobs.kdf))) {
    throw new WrongPassphraseError("Wrong passphrase.");
  }
  try {
    return await unwrapUnder(masterKey, blobs.wrappedUnderMaster);
  } catch {
    throw new CorruptedBlobError("Account key blob could not be unwrapped.");
  }
}

/** Unlock the account key with the recovery code (independent of the passphrase). */
export async function unlockWithRecovery(
  recoveryCode: string,
  blobs: AccountBlobs,
): Promise<CryptoKey> {
  const recoveryKey = await deriveRecoveryKey(recoveryCode); // throws WeakRecoveryCodeError
  try {
    return await unwrapUnder(recoveryKey, blobs.wrappedUnderRecovery);
  } catch {
    throw new CorruptedBlobError("Recovery blob could not be unwrapped (wrong code?).");
  }
}

/**
 * Rotate to a new passphrase. Re-wraps the SAME account key value under a new
 * master key + a fresh recovery code, and re-issues the verifier — O(1) in the
 * number of content keys, and the account key value is unchanged.
 */
export async function rotatePassphrase(
  newPassphrase: string,
  accountKey: CryptoKey,
): Promise<{
  blobs: AccountBlobs;
  recoveryCode: string;
  authTag: string;
  recoveryAuthTag: string;
}> {
  assertPassphraseStrength(newPassphrase);
  return buildBlobs(newPassphrase, accountKey);
}

/** Export raw account-key bytes (base64url) — used to assert key-value immutability. */
export async function exportAccountKeyRaw(accountKey: CryptoKey): Promise<string> {
  return b64(new Uint8Array(await subtle().exportKey("raw", accountKey)));
}

/** Wrap a per-share content key under the account key (for durable history). */
export async function wrapContentKey(
  accountKey: CryptoKey,
  contentKey: CryptoKey,
): Promise<WrappedKey> {
  return wrapUnder(accountKey, contentKey);
}

/** Unwrap a content key from history under the account key. */
export async function unwrapContentKey(
  accountKey: CryptoKey,
  blob: WrappedKey,
): Promise<CryptoKey> {
  return subtle().unwrapKey(
    "raw",
    unb64(blob.ct),
    accountKey,
    { name: "AES-GCM", iv: unb64(blob.iv) },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

// --- Per-box machine keys (@jsonl-tools/cli, plan U5/U6) ---
//
// A machine key sits one hop below the account key: the account key wraps the
// machine key; the machine key wraps per-upload content keys (via the existing
// wrapContentKey/unwrapContentKey, which accept any wrapping key). Unlike a
// content key, a machine key needs wrapKey/unwrapKey usages — so it has its own
// generate/import/unwrap helpers rather than reusing the content-key ones.

const MACHINE_KEY_USAGES: KeyUsage[] = ["wrapKey", "unwrapKey"];

/** Generate a per-box machine key — extractable (raw bytes go in the box credential). */
export async function generateMachineKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, MACHINE_KEY_USAGES);
}

/** Export the raw machine-key bytes as base64url (for the box credential). */
export async function exportMachineKeyRaw(machineKey: CryptoKey): Promise<string> {
  return b64(new Uint8Array(await subtle().exportKey("raw", machineKey)));
}

/** Re-import a machine key from its base64url raw bytes (CLI side). */
export async function importMachineKeyRaw(raw: string): Promise<CryptoKey> {
  return subtle().importKey("raw", unb64(raw), { name: "AES-GCM" }, true, MACHINE_KEY_USAGES);
}

/** Wrap the machine key under the account key (stored server-side at mint time). */
export async function wrapMachineKey(
  accountKey: CryptoKey,
  machineKey: CryptoKey,
): Promise<WrappedKey> {
  return wrapUnder(accountKey, machineKey);
}

/** Unwrap the machine key under the account key (web decrypt path, U6). */
export async function unwrapMachineKey(
  accountKey: CryptoKey,
  blob: WrappedKey,
): Promise<CryptoKey> {
  return subtle().unwrapKey(
    "raw",
    unb64(blob.ct),
    accountKey,
    { name: "AES-GCM", iv: unb64(blob.iv) },
    { name: "AES-GCM", length: 256 },
    true,
    MACHINE_KEY_USAGES,
  );
}
