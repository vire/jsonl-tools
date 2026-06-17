import { test, expect } from "bun:test";
import { parseShareLocation, parseShareId, loadShare, loadRemembered } from "./share-viewer-core";
import {
  generateShareId,
  generateContentKey,
  encryptSession,
  exportKeyToFragment,
} from "./share-crypto";

const jsonResponse = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

test("parseShareId extracts a bare id, ignoring any fragment", () => {
  const id = "a".repeat(43);
  expect(parseShareId(`/s/${id}`)).toBe(id);
  expect(parseShareId(`/s/${id}/`)).toBe(id); // trailing slash tolerated
  expect(parseShareId("/s/too-short")).toBeNull();
  expect(parseShareId("/")).toBeNull();
});

test("parseShareLocation extracts id + key, or returns null", () => {
  const id = "a".repeat(43);
  expect(parseShareLocation(`/s/${id}`, "#key=abc")).toEqual({ id, key: "abc" });
  expect(parseShareLocation(`/s/${id}`, "")).toBeNull(); // no key
  expect(parseShareLocation("/", "#key=abc")).toBeNull(); // not a share path
  expect(parseShareLocation("/s/too-short", "#key=abc")).toBeNull(); // bad id
});

test("loadShare decrypts a real envelope served by a stubbed fetch", async () => {
  const id = generateShareId();
  const key = await generateContentKey();
  const session = "line one\nline two";
  const env = await encryptSession(session, key, id);
  const fragment = await exportKeyToFragment(key);

  const state = await loadShare({ id, key: fragment }, jsonResponse(env));
  expect(state.status).toBe("ready");
  if (state.status === "ready") expect(state.plaintext).toBe(session);
});

test("loadShare maps 404 → unavailable and 5xx → retry", async () => {
  const id = generateShareId();
  const key = await exportKeyToFragment(await generateContentKey());
  expect((await loadShare({ id, key }, jsonResponse({}, 404))).status).toBe(
    "unavailable",
  );
  expect((await loadShare({ id, key }, jsonResponse({}, 503))).status).toBe(
    "retry",
  );
});

test("loadShare reports decrypt-failed for a wrong key", async () => {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("secret", key, id);
  const wrongFragment = await exportKeyToFragment(await generateContentKey());

  const state = await loadShare({ id, key: wrongFragment }, jsonResponse(env));
  expect(state.status).toBe("decrypt-failed");
});

test("loadRemembered decrypts using a recalled key", async () => {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("hello\nworld", key, id);
  const fragment = await exportKeyToFragment(key);
  const forgotten: string[] = [];

  const state = await loadRemembered(
    `/s/${id}`,
    async () => fragment, // recall hit
    async (x) => void forgotten.push(x),
    jsonResponse(env),
  );

  expect(state.status).toBe("ready");
  if (state.status === "ready") expect(state.plaintext).toBe("hello\nworld");
  expect(forgotten).toEqual([]); // a live share is never purged
});

test("loadRemembered returns no-key when nothing is stored", async () => {
  const id = generateShareId();
  const state = await loadRemembered(
    `/s/${id}`,
    async () => null, // recall miss
    async () => {},
    jsonResponse({}, 200),
  );
  expect(state.status).toBe("no-key");
});

test("loadRemembered returns no-key for a non-share path", async () => {
  const state = await loadRemembered(
    "/s/too-short",
    async () => "frag",
    async () => {},
    jsonResponse({}, 200),
  );
  expect(state.status).toBe("no-key");
});

test("loadRemembered purges the local key when the share is gone (404)", async () => {
  const id = generateShareId();
  const fragment = await exportKeyToFragment(await generateContentKey());
  const forgotten: string[] = [];

  const state = await loadRemembered(
    `/s/${id}`,
    async () => fragment,
    async (x) => void forgotten.push(x),
    jsonResponse({}, 404),
  );

  expect(state.status).toBe("unavailable");
  expect(forgotten).toEqual([id]); // dead key dropped
});
