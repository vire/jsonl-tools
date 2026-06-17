import { test, expect } from "bun:test";
import {
  encodeCredential,
  parseCredential,
  bearerFromCredential,
} from "./cli-credential";
import {
  setupAccount,
  generateMachineKey,
  exportMachineKeyRaw,
  importMachineKeyRaw,
  wrapMachineKey,
  unwrapMachineKey,
  wrapContentKey,
  unwrapContentKey,
} from "./account-crypto";
import { generateContentKey, encryptSession, decryptSession } from "./share-crypto";
import { mintCliTokenFlow } from "./account-client";

test("credential round-trips and the bearer omits the machine key", () => {
  const cred = { tokenId: "tok-123", authSecret: "sEcReT", machineKey: "mAcHiNe" };
  const encoded = encodeCredential(cred);
  expect(encoded.startsWith("jt1_")).toBe(true);
  const parsed = parseCredential(encoded);
  expect(parsed).toEqual(cred);
  // the Authorization value carries only id + secret, never the machine key
  const bearer = bearerFromCredential(cred);
  expect(bearer).toBe("tok-123.sEcReT");
  expect(bearer).not.toContain("mAcHiNe");
});

test("malformed credentials are rejected", () => {
  expect(parseCredential("")).toBeNull();
  expect(parseCredential("nope_a.b.c")).toBeNull(); // wrong prefix
  expect(parseCredential("jt1_only.two")).toBeNull(); // 2 parts
  expect(parseCredential("jt1_a.b.c.d")).toBeNull(); // 4 parts
  expect(parseCredential("jt1_a..c")).toBeNull(); // empty middle
  expect(parseCredential("jt1_a.b.c=bad")).toBeNull(); // illegal char
});

test("machine key wrap/unwrap round-trips and yields wrapKey/unwrapKey usages", async () => {
  const acct = await setupAccount("correct horse battery staple");
  const machineKey = await generateMachineKey();
  expect(machineKey.usages.sort()).toEqual(["unwrapKey", "wrapKey"]);

  const wrapped = await wrapMachineKey(acct.accountKey, machineKey);
  const unwrapped = await unwrapMachineKey(acct.accountKey, wrapped);
  // the unwrapped machine key must be able to unwrap content keys (KTD2 guard)
  expect(unwrapped.usages.sort()).toEqual(["unwrapKey", "wrapKey"]);

  // raw export/import preserves the key bytes
  const raw = await exportMachineKeyRaw(machineKey);
  const reimported = await importMachineKeyRaw(raw);
  expect(await exportMachineKeyRaw(reimported)).toBe(raw);
});

test("a content key wrapped under the machine key round-trips end to end", async () => {
  // mirrors the CLI path: machine key wraps the per-upload content key
  const machineKey = await generateMachineKey();
  const contentKey = await generateContentKey();
  const id = "x".repeat(43);
  const env = await encryptSession("a jsonl line\n", contentKey, id);

  const wrappedCk = await wrapContentKey(machineKey, contentKey);
  const recovered = await unwrapContentKey(machineKey, wrappedCk);
  const plain = await decryptSession(env, recovered, id);
  expect(plain).toBe("a jsonl line\n");
});

test("mintCliTokenFlow posts only the wrapped blob and returns a parseable credential", async () => {
  const acct = await setupAccount("correct horse battery staple");
  const rawMachineBytes: string[] = [];

  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    // the request carries the wrapped blob + label, NEVER a raw machine key
    expect(body.wrappedMachineKey).toHaveProperty("iv");
    expect(body.wrappedMachineKey).toHaveProperty("ct");
    expect(body.label).toBe("ci box");
    rawMachineBytes.push(JSON.stringify(body));
    return new Response(JSON.stringify({ tokenId: "tok-abc", authSecret: "secret-xyz" }), {
      status: 201,
    });
  }) as unknown as typeof fetch;

  const { credential, tokenId } = await mintCliTokenFlow(acct.accountKey, "ci box", fakeFetch);
  expect(tokenId).toBe("tok-abc");

  const parsed = parseCredential(credential)!;
  expect(parsed.tokenId).toBe("tok-abc");
  expect(parsed.authSecret).toBe("secret-xyz");
  expect(parsed.machineKey.length).toBeGreaterThan(0);

  // the raw machine-key bytes from the credential never appeared in the request body
  expect(rawMachineBytes.join("")).not.toContain(parsed.machineKey);

  // the credential's machine key re-imports to a usable machine key
  const reimported = await importMachineKeyRaw(parsed.machineKey);
  expect(reimported.usages.sort()).toEqual(["unwrapKey", "wrapKey"]);
});
