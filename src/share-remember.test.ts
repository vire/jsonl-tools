import "fake-indexeddb/auto";
import { test, expect } from "bun:test";
import {
  rememberShareKey,
  recallShareKey,
  forgetShareKey,
} from "./share-remember";

test("a remembered key fragment round-trips and can be recalled", async () => {
  const id = "a".repeat(43);
  expect(await recallShareKey(id)).toBeNull(); // nothing stored yet
  expect(await rememberShareKey(id, "frag-XYZ")).toBe(true); // write landed
  expect(await recallShareKey(id)).toBe("frag-XYZ");
});

test("forgetShareKey removes the stored key", async () => {
  const id = "b".repeat(43);
  await rememberShareKey(id, "frag-XYZ");
  expect(await recallShareKey(id)).toBe("frag-XYZ");
  await forgetShareKey(id);
  expect(await recallShareKey(id)).toBeNull();
});

test("recallShareKey returns null for an unknown id", async () => {
  expect(await recallShareKey("c".repeat(43))).toBeNull();
});
