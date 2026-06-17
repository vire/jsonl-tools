import "fake-indexeddb/auto";
import { test, expect } from "bun:test";
import { rememberShare, listLocalShares, forgetShare } from "./local-store";

async function aKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

test("remembered shares list newest-first and can be forgotten", async () => {
  const k = await aKey();
  await rememberShare({
    id: "a".repeat(43),
    link: "https://x.test/s/a#key=1",
    adminToken: "t1",
    contentKey: k,
    createdAt: 1000,
  });
  await rememberShare({
    id: "b".repeat(43),
    link: "https://x.test/s/b#key=2",
    adminToken: "t2",
    contentKey: k,
    createdAt: 2000,
  });

  const list = await listLocalShares();
  expect(list.map((s) => s.id)).toEqual(["b".repeat(43), "a".repeat(43)]);
  // the CryptoKey survives the IndexedDB round-trip (structured clone)
  expect(list[0]!.contentKey).toBeInstanceOf(CryptoKey);

  await forgetShare("b".repeat(43));
  const after = await listLocalShares();
  expect(after.map((s) => s.id)).toEqual(["a".repeat(43)]);
});
