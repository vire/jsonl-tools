import { test, expect } from "bun:test";
import {
  uploadContent,
  listUploads,
  downloadAll,
  downloadOne,
  viewLink,
  deleteUpload,
  uniqueName,
  type Deps,
  type FileSink,
} from "./core";
import { generateMachineKey, exportMachineKeyRaw } from "../src/account-crypto";
import { importKeyFromFragment, decryptSession } from "../src/share-crypto";
import { encodeCredential, parseCredential } from "../src/cli-credential";

// An in-memory stand-in for the server's CLI + share endpoints. Stores exactly
// what the real server stores (ciphertext envelope + wrapped content key) so the
// upload -> download/view crypto round-trip is exercised for real.
function makeServer(opts: { revoked?: boolean } = {}) {
  const uploads = new Map<string, any>();
  const tombstoned = new Set<string>(); // listed as active, but the share fetch 404s
  const requests: { url: string; body: string }[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : "";
    requests.push({ url: String(url), body });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

    if (path === "/api/cli/uploads" && method === "POST") {
      if (opts.revoked) return json({ error: "unauthorized" }, 401);
      const b = JSON.parse(body);
      uploads.set(b.id, {
        shareId: b.id,
        env: { v: b.v, iv: b.iv, ct: b.ct, encryptedTitle: b.encryptedTitle ?? null },
        encryptedTitle: b.encryptedTitle ?? null,
        wrappedContentKey: b.wrappedContentKey,
        sizeBytes: Buffer.from(b.ct, "base64url").length,
        createdAt: "2026-06-05T00:00:00Z",
        state: "active",
      });
      return json({ id: b.id }, 201);
    }
    if (path === "/api/cli/uploads" && method === "GET") {
      if (opts.revoked) return json({ error: "unauthorized" }, 401);
      return json({
        items: [...uploads.values()].map((r) => ({
          shareId: r.shareId,
          encryptedTitle: r.encryptedTitle,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt,
          state: r.state,
          wrappedContentKey: r.wrappedContentKey,
        })),
      });
    }
    if (path.startsWith("/api/cli/uploads/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/cli/uploads/".length));
      uploads.delete(id);
      return json({ ok: true });
    }
    if (path.startsWith("/api/shares/") && method === "GET") {
      const id = path.slice("/api/shares/".length);
      const r = uploads.get(id);
      if (!r || tombstoned.has(id)) return json({ error: "unavailable" }, 404);
      return json(r.env);
    }
    return json({ error: "not_found" }, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, requests, uploads, tombstoned };
}

async function makeDeps(server: ReturnType<typeof makeServer>): Promise<Deps> {
  const machineKey = await generateMachineKey();
  const raw = await exportMachineKeyRaw(machineKey);
  const credential = parseCredential(encodeCredential({ tokenId: "tok", authSecret: "sec", machineKey: raw }))!;
  return { baseUrl: "https://jsonl-tools.test", credential, fetchImpl: server.fetchImpl };
}

const JSONL = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"yo"}\n';

test("upload then list round-trips, server stores only ciphertext", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);

  const { id } = await uploadContent(deps, { filename: "log.jsonl", content: JSONL, title: "My Log" });
  // the server never saw plaintext or the content key
  const uploadBody = server.requests.find((r) => r.url.endsWith("/api/cli/uploads") && r.body)!.body;
  expect(uploadBody).not.toContain("role");
  expect(uploadBody).not.toContain("My Log");

  const items = await listUploads(deps);
  expect(items.map((i) => i.shareId)).toEqual([id]);
});

test("AE1: a file over the ceiling throws with the filename and uploads nothing", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);
  const huge = "x".repeat(25 * 1024 * 1024 + 100);
  await expect(
    uploadContent(deps, { filename: "huge.jsonl", content: huge }),
  ).rejects.toThrow(/huge\.jsonl.*limit/);
  // nothing was POSTed
  expect(server.requests.some((r) => r.url.endsWith("/api/cli/uploads") && r.body)).toBe(false);
});

test("download decrypts back to the original JSONL", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);
  await uploadContent(deps, { filename: "log.jsonl", content: JSONL });

  const items = await listUploads(deps);
  const decrypted = await downloadOne(deps, items[0]!);
  expect(decrypted).toBe(JSONL);
});

test("AE3: downloadAll writes a file per upload and never silently overwrites", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);
  const a = await uploadContent(deps, { filename: "a.jsonl", content: JSONL });
  const b = await uploadContent(deps, { filename: "b.jsonl", content: JSONL });

  const files = new Map<string, string>();
  files.set(`${a.id}.jsonl`, "PREEXISTING"); // collide with one upload's name
  const sink: FileSink = {
    exists: (n) => files.has(n),
    write: (n, c) => void files.set(n, c),
  };
  const { written, failed } = await downloadAll(deps, sink);
  expect(written.length).toBe(2);
  expect(failed.length).toBe(0);
  // the pre-existing file was not clobbered
  expect(files.get(`${a.id}.jsonl`)).toBe("PREEXISTING");
  // its upload landed under a suffixed name with the real content
  expect(files.get(`${a.id}-1.jsonl`)).toBe(JSONL);
  expect(files.get(`${b.id}.jsonl`)).toBe(JSONL);
});

test("downloadAll writes the successes and reports failures (partial-failure resilience)", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);
  const ok = await uploadContent(deps, { filename: "ok.jsonl", content: JSONL });
  const gone = await uploadContent(deps, { filename: "gone.jsonl", content: JSONL });
  // simulate a share tombstoned between the list and the download: still listed
  // as active, but its ciphertext fetch 404s.
  server.tombstoned.add(gone.id);

  const files = new Map<string, string>();
  const sink: FileSink = { exists: (n) => files.has(n), write: (n, c) => void files.set(n, c) };
  const { written, failed } = await downloadAll(deps, sink);

  // the still-present upload was written; the missing one is reported, not fatal
  expect(written).toEqual([`${ok.id}.jsonl`]);
  expect(files.get(`${ok.id}.jsonl`)).toBe(JSONL);
  expect(failed.map((f) => f.shareId)).toEqual([gone.id]);
});

test("uniqueName suffixes past multiple collisions", () => {
  const taken = new Set(["x.jsonl", "x-1.jsonl", "x-2.jsonl"]);
  const sink: FileSink = { exists: (n) => taken.has(n), write: () => {} };
  expect(uniqueName("x.jsonl", sink)).toBe("x-3.jsonl");
  expect(uniqueName("fresh.jsonl", sink)).toBe("fresh.jsonl");
});

test("AE5: view prints a link whose fragment decrypts the share, and the key is never sent", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);
  await uploadContent(deps, { filename: "log.jsonl", content: JSONL });

  const items = await listUploads(deps);
  const link = await viewLink(deps, items[0]!);
  const fragment = link.split("#key=")[1]!;
  expect(fragment.length).toBeGreaterThan(0);

  // the fragment (the decryption key) never appeared in any request to the server
  for (const r of server.requests) {
    expect(r.url).not.toContain(fragment);
    expect(r.body).not.toContain(fragment);
  }

  // and the fragment really does decrypt the share (open it like the viewer would)
  const shareRes = await server.fetchImpl(`https://jsonl-tools.test/api/shares/${items[0]!.shareId}`);
  const env = (await shareRes.json()) as any;
  const key = await importKeyFromFragment(fragment);
  expect(await decryptSession(env, key, items[0]!.shareId)).toBe(JSONL);
});

test("delete removes an upload from the list", async () => {
  const server = makeServer();
  const deps = await makeDeps(server);
  const { id } = await uploadContent(deps, { filename: "log.jsonl", content: JSONL });
  await deleteUpload(deps, id);
  expect((await listUploads(deps)).some((i) => i.shareId === id)).toBe(false);
});

test("AE2: a revoked token's upload fails clearly", async () => {
  const server = makeServer({ revoked: true });
  const deps = await makeDeps(server);
  await expect(
    uploadContent(deps, { filename: "log.jsonl", content: JSONL }),
  ).rejects.toThrow(/Upload failed/);
});
