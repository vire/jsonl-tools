import { test, expect, afterEach } from "bun:test";
import { createShare, revokeShare } from "./api-client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("createShare uploads only ciphertext and puts the key in the fragment", async () => {
  let uploaded: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    uploaded = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ id: uploaded!.id, adminToken: "admintok" }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const session = "TOPSECRET customer order #4815 for acme corp";
  const out = await createShare(session, { origin: "https://example.test" });

  // the plaintext session is never in the upload body
  expect(uploaded).not.toBeNull();
  expect(JSON.stringify(uploaded)).not.toContain("TOPSECRET customer order");
  expect(typeof uploaded!.ct).toBe("string");
  expect((uploaded!.ct as string).length).toBeGreaterThan(0);

  // the link carries the key ONLY in the fragment, and the server never saw it
  const [path, fragment] = out.link.split("#");
  expect(path).toBe(`https://example.test/s/${out.id}`);
  expect(fragment).toMatch(/^key=[A-Za-z0-9_-]+$/);
  const keyValue = fragment!.slice("key=".length);
  expect(JSON.stringify(uploaded)).not.toContain(keyValue);

  expect(out.adminToken).toBe("admintok");
});

test("createShare throws on a non-OK response", async () => {
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as typeof fetch;
  await expect(createShare("data")).rejects.toThrow(/HTTP 500/);
});

test("revokeShare DELETEs the share id with the admin token header", async () => {
  let calledUrl: string | null = null;
  let init: RequestInit | null = null;
  globalThis.fetch = (async (url: string, i: RequestInit) => {
    calledUrl = String(url);
    init = i;
    return new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await revokeShare("abc123", "admintok");

  expect(calledUrl).toBe("/api/shares/abc123");
  expect(init!.method).toBe("DELETE");
  expect(new Headers(init!.headers).get("x-admin-token")).toBe("admintok");
});

test("revokeShare throws on a non-OK response", async () => {
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as typeof fetch;
  await expect(revokeShare("abc", "tok")).rejects.toThrow(/HTTP 500/);
});
