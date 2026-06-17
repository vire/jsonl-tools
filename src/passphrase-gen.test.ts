import { test, expect } from "bun:test";
import { generatePassphrase, secureIndex, WORDLIST } from "./passphrase-gen";
import { MIN_PASSPHRASE_LENGTH } from "./account-crypto";

test("wordlist is the full EFF large list of unique words", () => {
  expect(WORDLIST.length).toBe(7776);
  expect(new Set(WORDLIST).size).toBe(7776);
});

test("uses the injected index function and joins words with hyphens", () => {
  const seq = [0, 1, 2, 3, 4];
  let i = 0;
  const phrase = generatePassphrase(5, () => seq[i++]!);
  expect(phrase).toBe(seq.map((n) => WORDLIST[n]).join("-"));
});

test("defaults to 5 words; honors a custom count", () => {
  expect(generatePassphrase().split("-").length).toBe(5);
  expect(generatePassphrase(3).split("-").length).toBe(3);
});

test("every generated word is from the wordlist", () => {
  const set = new Set(WORDLIST);
  for (const w of generatePassphrase(5).split("-")) expect(set.has(w)).toBe(true);
});

test("successive real calls differ", () => {
  expect(generatePassphrase()).not.toBe(generatePassphrase());
});

test("default output clears the passphrase length floor", () => {
  expect(generatePassphrase().length).toBeGreaterThanOrEqual(MIN_PASSPHRASE_LENGTH);
});

test("secureIndex stays in range and covers every residue (no bias gap)", () => {
  const counts = new Array(6).fill(0);
  for (let n = 0; n < 12000; n++) {
    const v = secureIndex(6);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(6);
    counts[v]++;
  }
  expect(counts.every((c) => c > 0)).toBe(true);
});
