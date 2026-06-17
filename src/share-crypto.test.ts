import { test, expect } from "bun:test";
import {
  assertCryptoAvailable,
  generateShareId,
  generateContentKey,
  exportKeyToFragment,
  importKeyFromFragment,
  encryptSession,
  decryptSession,
  SecureContextError,
  DecryptError,
  type ShareEnvelope,
} from "./share-crypto";

const SESSION = `{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}`;

const ID_A = "abc123";
const ID_B = "def456";

test("encrypt then decrypt round-trips a session", async () => {
  const key = await generateContentKey();
  const env = await encryptSession(SESSION, key, ID_A);
  const out = await decryptSession(env, key, ID_A);
  expect(out).toBe(SESSION);
});

test("a key exported to the fragment and re-imported still decrypts", async () => {
  const key = await generateContentKey();
  const env = await encryptSession(SESSION, key, ID_A);

  const fragment = await exportKeyToFragment(key);
  const reimported = await importKeyFromFragment(fragment);

  expect(await decryptSession(env, reimported, ID_A)).toBe(SESSION);
});

test("decrypting with the wrong key fails and never returns plaintext", async () => {
  const key = await generateContentKey();
  const wrong = await generateContentKey();
  const env = await encryptSession(SESSION, key, ID_A);

  await expect(decryptSession(env, wrong, ID_A)).rejects.toBeInstanceOf(
    DecryptError,
  );
});

test("a tampered ciphertext fails authentication", async () => {
  const key = await generateContentKey();
  const env = await encryptSession(SESSION, key, ID_A);

  // flip a character in the base64url ciphertext
  const flipped = env.ct[0] === "A" ? "B" : "A";
  const tampered: ShareEnvelope = { ...env, ct: flipped + env.ct.slice(1) };

  await expect(decryptSession(tampered, key, ID_A)).rejects.toBeInstanceOf(
    DecryptError,
  );
});

test("ciphertext bound to one share id fails to decrypt under another (AAD id-binding)", async () => {
  const key = await generateContentKey();
  const env = await encryptSession(SESSION, key, ID_A);

  await expect(decryptSession(env, key, ID_B)).rejects.toBeInstanceOf(
    DecryptError,
  );
});

test("the IV differs across repeated encryptions of the same plaintext", async () => {
  const key = await generateContentKey();
  const a = await encryptSession(SESSION, key, ID_A);
  const b = await encryptSession(SESSION, key, ID_A);
  expect(a.iv).not.toBe(b.iv);
});

test("base64url fragment encode/decode is lossless for random key bytes", async () => {
  const key = await generateContentKey();
  const fragment = await exportKeyToFragment(key);
  // base64url alphabet only: no +, /, or = padding
  expect(fragment).not.toMatch(/[+/=]/);

  const reimported = await importKeyFromFragment(fragment);
  const again = await exportKeyToFragment(reimported);
  expect(again).toBe(fragment);
});

test("generateShareId yields unique 43-char base64url ids with no timestamp", () => {
  const a = generateShareId();
  const b = generateShareId();
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(b);
});

test("assertCryptoAvailable throws SecureContextError when subtle is absent", () => {
  // null models a non-secure context; unlike undefined it does not trigger the
  // default param, so the absent branch is actually exercised
  expect(() => assertCryptoAvailable(null)).toThrow(SecureContextError);
  // present case returns the subtle object it was given
  const subtle = globalThis.crypto.subtle;
  expect(assertCryptoAvailable(subtle)).toBe(subtle);
});
