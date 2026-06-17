import { test, expect, afterAll, beforeEach } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import {
  checkRateLimit,
  resetRateLimits,
  clientIp,
  hashIp,
  isBanned,
  banIp,
  takedown,
  handleReportAbuse,
} from "./abuse";
import { handleCreateShare } from "./shares";
import { generateShareId, generateContentKey, encryptSession } from "../share-crypto";

const dbTest = process.env.DATABASE_URL ? test : test.skip;

beforeEach(() => resetRateLimits());
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

// --- pure logic (no DB) ---

test("checkRateLimit allows up to the limit then blocks, and recovers after the window", () => {
  const t0 = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (checkRateLimit("k", t0 + i)) allowed++;
  expect(allowed).toBe(60); // RATE_MAX within the window
  // far in the future the window has slid — allowed again
  expect(checkRateLimit("k", t0 + 10 * 60_000)).toBe(true);
});

test("clientIp ignores X-Forwarded-For with no trusted proxy, and uses the right-most hop with one", () => {
  const prevProxy = process.env.TRUSTED_PROXY;
  const prevHops = process.env.TRUSTED_PROXY_HOPS;
  delete process.env.TRUSTED_PROXY_HOPS;

  const single = new Request("http://localhost/", {
    headers: { "x-forwarded-for": "9.9.9.9" },
  });
  // a client trying to spoof: it prepends a fake; the trusted proxy appends the
  // real peer as the right-most entry
  const spoofed = new Request("http://localhost/", {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
  });

  delete process.env.TRUSTED_PROXY;
  expect(clientIp(single, "10.0.0.1")).toBe("10.0.0.1"); // XFF ignored, direct IP used

  process.env.TRUSTED_PROXY = "1";
  expect(clientIp(single, "10.0.0.1")).toBe("9.9.9.9"); // one hop, single entry
  expect(clientIp(spoofed, "10.0.0.1")).toBe("5.6.7.8"); // right-most, spoof ignored

  if (prevProxy === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = prevProxy;
  if (prevHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = prevHops;
});

// --- DB-backed ---

function reportReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/report", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

dbTest("report-abuse is opaque, records the report, and never confirms existence", async () => {
  await migrate();

  // cross-site is rejected
  const xs = await handleReportAbuse(
    reportReq({ shareId: "x", reason: "bad" }, { "sec-fetch-site": "cross-site" }),
    "1.1.1.1",
  );
  expect(xs.status).toBe(403);

  // a report for an unknown id still returns ok, with a null share link (no leak)
  const res = await handleReportAbuse(
    reportReq({ shareId: generateShareId(), reason: "spam" }),
    "1.1.1.1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const sql = getSql();
  const rows = await sql`SELECT share_id, reason FROM report_abuse WHERE reason = 'spam' ORDER BY id DESC LIMIT 1`;
  expect(rows[0]!.share_id).toBeNull();
  expect(rows[0]!.reason).toBe("spam");
});

dbTest("a banned IP cannot create shares", async () => {
  await migrate();
  const ip = "203.0.113.7";
  await banIp(hashIp(ip), "test ban");
  expect(await isBanned(hashIp(ip))).toBe(true);

  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("x", key, id);
  const req = new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ id, v: env.v, iv: env.iv, ct: env.ct }),
  });
  const res = await handleCreateShare(req, ip);
  expect(res.status).toBe(403);
});

dbTest("operator takedown tombstones a share and clears its uploader IP", async () => {
  await migrate();
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("x", key, id);
  const createReq = new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ id, v: env.v, iv: env.iv, ct: env.ct }),
  });
  await handleCreateShare(createReq, "198.51.100.2");

  await takedown(id);

  const sql = getSql();
  const rows = await sql`SELECT state, ciphertext, uploader_ip_hash FROM shares WHERE id = ${id}`;
  expect(rows[0]!.state).toBe("deleted");
  expect(rows[0]!.ciphertext).toBeNull();
  expect(rows[0]!.uploader_ip_hash).toBeNull();
});
