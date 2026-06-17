// Client-side passphrase generator (design 2026-06-04). Produces a hyphen-joined
// word passphrase the user stores in a password manager. Word selection is
// uniform via rejection sampling over crypto.getRandomValues — no modulo bias.
//
// Wordlist: EFF "large" wordlist (7776 words), © Electronic Frontier Foundation,
// licensed CC-BY 3.0 US. Vendored verbatim (words only) in ./wordlist-eff.txt.

import wordlistText from "./wordlist-eff.txt" with { type: "text" };

export const WORDLIST: readonly string[] = wordlistText
  .split("\n")
  .map((w) => w.trim())
  .filter(Boolean);

/** Uniform random integer in [0, bound) from Web Crypto, rejection-sampled. */
export function secureIndex(bound: number): number {
  if (bound <= 0) throw new RangeError("bound must be positive");
  const range = 0x1_0000_0000; // 2^32
  const limit = Math.floor(range / bound) * bound; // largest unbiased multiple
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % bound;
}

/** A hyphen-joined passphrase of `wordCount` words drawn from WORDLIST. */
export function generatePassphrase(
  wordCount = 5,
  nextIndex: (bound: number) => number = secureIndex,
): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(WORDLIST[nextIndex(WORDLIST.length)]!);
  return words.join("-");
}
