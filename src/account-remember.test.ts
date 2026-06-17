import "fake-indexeddb/auto";
import { test, expect } from "bun:test";
import {
  rememberAccount,
  recallAccount,
  forgetAccount,
  isRemembered,
} from "./account-remember";
import {
  ACCOUNT_KEY_USAGES,
  wrapContentKey,
  unwrapContentKey,
} from "./account-crypto";

async function makeAccountKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ACCOUNT_KEY_USAGES);
}
async function makeContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

test("recall returns the same account key value that was remembered", async () => {
  const accountKey = await makeAccountKey();
  await rememberAccount("octocat", accountKey);
  const recalled = await recallAccount("octocat");
  expect(recalled).not.toBeNull();

  // Functional byte-equality proof: a content key wrapped under the ORIGINAL key
  // must unwrap under the RECALLED key (AES-GCM integrity fails otherwise), and
  // decrypt data the original content key encrypted.
  const contentKey = await makeContentKey();
  const blob = await wrapContentKey(accountKey, contentKey);
  const recalledContentKey = await unwrapContentKey(recalled!, blob);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, new TextEncoder().encode("hi"));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, recalledContentKey, ct);
  expect(new TextDecoder().decode(pt)).toBe("hi");
});

test("the recalled key is non-extractable", async () => {
  await rememberAccount("mona", await makeAccountKey());
  const recalled = await recallAccount("mona");
  expect(recalled!.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("raw", recalled!)).rejects.toThrow();
});

test("recall is null for an unknown login, and isRemembered tracks forget", async () => {
  expect(await recallAccount("nobody")).toBeNull();
  await rememberAccount("temp", await makeAccountKey());
  expect(await isRemembered("temp")).toBe(true);
  await forgetAccount("temp");
  expect(await isRemembered("temp")).toBe(false);
  expect(await recallAccount("temp")).toBeNull();
});

test("entries are isolated by login (no cross-user recall)", async () => {
  await rememberAccount("alice", await makeAccountKey());
  expect(await recallAccount("bob")).toBeNull();
});
