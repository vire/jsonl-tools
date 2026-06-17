import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { getSessionId, fetchWithSession, surfaceFetch } from "./session-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// sessionStorage is absent under bun test; inject an in-memory mock per test.
function mockStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    key: (i: number) => [...m.keys()][i] ?? null,
  } as Storage;
}

let saved: unknown;
beforeEach(() => {
  saved = (globalThis as any).sessionStorage;
  (globalThis as any).sessionStorage = mockStorage();
});
afterEach(() => {
  (globalThis as any).sessionStorage = saved;
});

function captureFetch() {
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(((input: any, init: any) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("ok"));
  }) as any);
  return { calls, spy };
}

test("getSessionId issues a stable UUID for the home surface", () => {
  const home1 = getSessionId("home");
  const home2 = getSessionId("home");
  expect(home1).toMatch(UUID_RE);
  expect(home2).toBe(home1); // stable within a session
});

test("getSessionId is undefined and storage-free for the session-less surfaces", () => {
  const store = (globalThis as any).sessionStorage as Storage;
  const setSpy = spyOn(store, "setItem");
  const getSpy = spyOn(store, "getItem");
  for (const surface of ["viewer", "bulk-analyzer"] as const) {
    expect(getSessionId(surface)).toBeUndefined();
    expect(getSessionId(surface)).toBeUndefined();
  }
  expect(setSpy).not.toHaveBeenCalled();
  expect(getSpy).not.toHaveBeenCalled();
});

test("getSessionId returns undefined (no throw) when sessionStorage is absent", () => {
  (globalThis as any).sessionStorage = undefined;
  expect(getSessionId("home")).toBeUndefined();
  expect(getSessionId("bulk-analyzer")).toBeUndefined();
});

test("Covers AE2: viewer requests carry the surface label but no session id", async () => {
  const { calls, spy } = captureFetch();
  try {
    await fetchWithSession("/api/shares/abc", undefined, "viewer");
    expect(calls.length).toBe(1);
    // The request is the bare path — never the #key fragment (URL-blind module).
    expect(calls[0]!.input).toBe("/api/shares/abc");
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("X-Anon-Surface")).toBe("viewer");
    expect(headers.get("X-Anon-Session")).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

test("home requests carry both the surface label and a session id", async () => {
  const { calls, spy } = captureFetch();
  try {
    await fetchWithSession("/api/auth/me", undefined, "home");
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("X-Anon-Surface")).toBe("home");
    expect(headers.get("X-Anon-Session")).toMatch(UUID_RE);
  } finally {
    spy.mockRestore();
  }
});

test("non-/api, data:, and cross-origin requests are delegated untouched", async () => {
  const { calls, spy } = captureFetch();
  try {
    await fetchWithSession("data:text/plain,hi", undefined, "home");
    await fetchWithSession("https://evil.example/api/x", undefined, "home");
    await fetchWithSession("/not-api/thing", undefined, "home");
    expect(calls.length).toBe(3);
    for (const c of calls) {
      const headers = new Headers(c.init?.headers);
      expect(headers.get("X-Anon-Surface")).toBeNull();
      expect(headers.get("X-Anon-Session")).toBeNull();
    }
    expect(calls[0]!.init).toBeUndefined(); // init passed through verbatim
  } finally {
    spy.mockRestore();
  }
});

test("surfaceFetch binds a surface into a drop-in fetch and preserves init", async () => {
  const { calls, spy } = captureFetch();
  try {
    const f = surfaceFetch("bulk-analyzer");
    await f("/api/events", { method: "POST" });
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("X-Anon-Surface")).toBe("bulk-analyzer");
    expect(headers.get("X-Anon-Session")).toBeNull(); // bulk carries no session id
    expect(calls[0]!.init!.method).toBe("POST");
  } finally {
    spy.mockRestore();
  }
});
