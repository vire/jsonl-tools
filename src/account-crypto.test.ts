import { test, expect } from "bun:test";
import {
  setupAccount,
  unlockWithPassphrase,
  unlockWithRecovery,
  rotatePassphrase,
  exportAccountKeyRaw,
  WrongPassphraseError,
  CorruptedBlobError,
  WeakPassphraseError,
  WeakRecoveryCodeError,
  KdfDowngradeError,
} from "./account-crypto";

const GOOD = "correct horse battery staple";

test("setup then unlock with the passphrase yields the same account key", async () => {
  const { blobs, accountKey } = await setupAccount(GOOD);
  const unlocked = await unlockWithPassphrase(GOOD, blobs);
  expect(await exportAccountKeyRaw(unlocked)).toBe(await exportAccountKeyRaw(accountKey));
});

test("a wrong passphrase fails as WrongPassphrase, distinct from corruption", async () => {
  const { blobs } = await setupAccount(GOOD);
  await expect(unlockWithPassphrase("wrong passphrase here", blobs)).rejects.toBeInstanceOf(
    WrongPassphraseError,
  );
});

test("a corrupted account-key blob (correct passphrase) is CorruptedBlob, not WrongPassphrase", async () => {
  const { blobs } = await setupAccount(GOOD);
  // corrupt only the master-wrapped account key; leave the verifier intact
  const ct = blobs.wrappedUnderMaster.ct;
  const corrupted = {
    ...blobs,
    wrappedUnderMaster: { ...blobs.wrappedUnderMaster, ct: (ct[0] === "A" ? "B" : "A") + ct.slice(1) },
  };
  await expect(unlockWithPassphrase(GOOD, corrupted)).rejects.toBeInstanceOf(CorruptedBlobError);
});

test("KDF parameters below the floor are rejected before any derivation", async () => {
  const { blobs } = await setupAccount(GOOD);
  const downgraded = { ...blobs, kdf: { ...blobs.kdf, iterations: 1000 } };
  await expect(unlockWithPassphrase(GOOD, downgraded)).rejects.toBeInstanceOf(KdfDowngradeError);
});

test("a weak passphrase is rejected at setup and at rotation", async () => {
  await expect(setupAccount("short")).rejects.toBeInstanceOf(WeakPassphraseError);
  const { accountKey } = await setupAccount(GOOD);
  await expect(rotatePassphrase("short", accountKey)).rejects.toBeInstanceOf(WeakPassphraseError);
});

test("the recovery code unlocks the same account key independent of the passphrase", async () => {
  const { blobs, recoveryCode, accountKey } = await setupAccount(GOOD);
  const viaRecovery = await unlockWithRecovery(recoveryCode, blobs);
  // byte-identical: the account key value is immutable (reconcile depends on this)
  expect(await exportAccountKeyRaw(viaRecovery)).toBe(await exportAccountKeyRaw(accountKey));
});

test("a sub-128-bit recovery code is rejected", async () => {
  const { blobs } = await setupAccount(GOOD);
  await expect(unlockWithRecovery("tooshort", blobs)).rejects.toBeInstanceOf(
    WeakRecoveryCodeError,
  );
});

test("rotation keeps the account key value, invalidates the old passphrase + recovery code", async () => {
  const first = await setupAccount(GOOD);
  const original = await exportAccountKeyRaw(first.accountKey);

  const NEW = "a different strong passphrase";
  const rotated = await rotatePassphrase(NEW, first.accountKey);

  // new passphrase unlocks the SAME account key value
  const viaNew = await unlockWithPassphrase(NEW, rotated.blobs);
  expect(await exportAccountKeyRaw(viaNew)).toBe(original);

  // old passphrase no longer unlocks the rotated blobs
  await expect(unlockWithPassphrase(GOOD, rotated.blobs)).rejects.toBeInstanceOf(
    WrongPassphraseError,
  );

  // new recovery code works; old one does not
  expect(await exportAccountKeyRaw(await unlockWithRecovery(rotated.recoveryCode, rotated.blobs))).toBe(
    original,
  );
  await expect(unlockWithRecovery(first.recoveryCode, rotated.blobs)).rejects.toBeInstanceOf(
    CorruptedBlobError,
  );
});
