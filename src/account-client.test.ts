import { test, expect } from "bun:test";
import {
  setupAccountFlow,
  unlockAccountFlow,
  recoverAccountFlow,
  verifyRecoveryCode,
  rotateAfterRecovery,
  createSharedToHistory,
  fetchHistoryDecrypted,
  reconcileLocalShare,
  deleteHistoryEntry,
  saveToHistory,
  setHistoryShareState,
  renameHistoryEntry,
} from "./account-client";
import {
  exportAccountKeyRaw,
  generateMachineKey,
  wrapMachineKey,
  wrapContentKey,
} from "./account-crypto";
import { generateContentKey, encryptSession, importKeyFromFragment, decryptSession } from "./share-crypto";

const PASS = "correct horse battery staple";
const NEW_PASS = "a different strong passphrase";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A tiny in-memory server so the client orchestration can be exercised end to end.
function makeFakeServer() {
  let account: Record<string, any> | null = null;
  const history: any[] = [];
  let lastUpload: any = null;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;

    if (u === "/api/account" && method === "POST") {
      lastUpload = body;
      account = { ...body.blobs, authTag: body.authTag, recoveryAuthTag: body.recoveryAuthTag };
      return jsonRes({ ok: true }, 201);
    }
    if (u === "/api/account" && method === "GET") {
      if (!account) return jsonRes({ error: "no_account" }, 404);
      return jsonRes({
        kdf: account.kdf,
        wrappedUnderMaster: account.wrappedUnderMaster,
        verifier: account.verifier,
      });
    }
    if (u === "/api/account/recovery") {
      return jsonRes({ wrappedUnderRecovery: account!.wrappedUnderRecovery });
    }
    if (u === "/api/account/rotate" && method === "POST") {
      if (
        body.currentAuthTag !== account!.authTag &&
        body.currentAuthTag !== account!.recoveryAuthTag
      ) {
        return jsonRes({ error: "forbidden" }, 403);
      }
      account = { ...body.blobs, authTag: body.authTag, recoveryAuthTag: body.recoveryAuthTag };
      return jsonRes({ ok: true });
    }
    if (u === "/api/shares" && method === "POST") {
      lastUpload = body;
      if (body.wrappedContentKey) {
        history.push({
          shareId: body.id,
          wrappedContentKey: body.wrappedContentKey,
          encryptedTitle: body.encryptedTitle,
        });
      }
      return jsonRes({ id: body.id, adminToken: "tok" }, 201);
    }
    if (u === "/api/history" && method === "GET") {
      return jsonRes({
        items: history.map((h) => ({
          ...h,
          sizeBytes: 1,
          createdAt: "now",
          expiresAt: null,
          state: "active",
        })),
      });
    }
    if (u === "/api/reconcile" && method === "POST") {
      lastUpload = body;
      if (!history.some((h) => h.shareId === body.shareId)) {
        history.push({ shareId: body.shareId, wrappedContentKey: body.wrappedContentKey, encryptedTitle: null });
      }
      return jsonRes({ ok: true });
    }
    const delMatch = u.match(/^\/api\/history\/([^/]+)$/);
    if (delMatch && method === "DELETE") {
      const shareId = decodeURIComponent(delMatch[1]!);
      const i = history.findIndex((h) => h.shareId === shareId);
      if (i !== -1) history.splice(i, 1);
      return jsonRes({ ok: true });
    }
    return jsonRes({ error: "not_found" }, 404);
  }) as typeof fetch;

  return { fetchImpl, lastUpload: () => lastUpload };
}

test("setup uploads only wrapped blobs — no passphrase, recovery code, or raw key", async () => {
  const srv = makeFakeServer();
  const { recoveryCode } = await setupAccountFlow(PASS, srv.fetchImpl);
  const upload = JSON.stringify(srv.lastUpload());
  expect(upload).not.toContain(PASS);
  expect(upload).not.toContain(recoveryCode);
  expect(srv.lastUpload().blobs.wrappedUnderMaster).toBeTruthy();
  expect(srv.lastUpload().authTag).toBeTruthy();
});

test("setup then unlock yields the same account key", async () => {
  const srv = makeFakeServer();
  const a = await setupAccountFlow(PASS, srv.fetchImpl);
  const b = await unlockAccountFlow(PASS, srv.fetchImpl);
  expect(await exportAccountKeyRaw(b.accountKey)).toBe(
    await exportAccountKeyRaw(a.account.accountKey),
  );
});

test("recovery sets a new passphrase that unlocks the same account key", async () => {
  const srv = makeFakeServer();
  const a = await setupAccountFlow(PASS, srv.fetchImpl);
  const orig = await exportAccountKeyRaw(a.account.accountKey);

  const rec = await recoverAccountFlow(a.recoveryCode, NEW_PASS, srv.fetchImpl);
  expect(await exportAccountKeyRaw(rec.account.accountKey)).toBe(orig);

  const u = await unlockAccountFlow(NEW_PASS, srv.fetchImpl);
  expect(await exportAccountKeyRaw(u.accountKey)).toBe(orig);
});

test("verifyRecoveryCode unlocks with the real code and rejects a wrong one", async () => {
  const srv = makeFakeServer();
  const a = await setupAccountFlow(PASS, srv.fetchImpl);
  const orig = await exportAccountKeyRaw(a.account.accountKey);

  // The genuine code yields the same account key, without writing to the server.
  const key = await verifyRecoveryCode(a.recoveryCode, srv.fetchImpl);
  expect(await exportAccountKeyRaw(key)).toBe(orig);

  // A well-formed but wrong code (one character flipped) must be rejected.
  const wrong = (a.recoveryCode[0] === "A" ? "B" : "A") + a.recoveryCode.slice(1);
  await expect(verifyRecoveryCode(wrong, srv.fetchImpl)).rejects.toThrow();
});

test("rotateAfterRecovery sets a new passphrase using a verified key", async () => {
  const srv = makeFakeServer();
  const a = await setupAccountFlow(PASS, srv.fetchImpl);
  const orig = await exportAccountKeyRaw(a.account.accountKey);

  const key = await verifyRecoveryCode(a.recoveryCode, srv.fetchImpl);
  const rec = await rotateAfterRecovery(a.recoveryCode, key, NEW_PASS, srv.fetchImpl);
  expect(await exportAccountKeyRaw(rec.account.accountKey)).toBe(orig);

  // The new passphrase now unlocks the same account key.
  const u = await unlockAccountFlow(NEW_PASS, srv.fetchImpl);
  expect(await exportAccountKeyRaw(u.accountKey)).toBe(orig);
});

test("createSharedToHistory uploads no plaintext and lands in decryptable history", async () => {
  const srv = makeFakeServer();
  const { account } = await setupAccountFlow(PASS, srv.fetchImpl);

  const SESSION = "SECRET session line";
  const TITLE = "My Title";
  const created = await createSharedToHistory(
    SESSION,
    account.accountKey,
    { title: TITLE, origin: "https://x.test" },
    srv.fetchImpl,
  );

  const upload = JSON.stringify(srv.lastUpload());
  expect(upload).not.toContain("SECRET session line");
  expect(upload).not.toContain(TITLE);
  expect(srv.lastUpload().wrappedContentKey).toBeTruthy();

  const items = await fetchHistoryDecrypted(account.accountKey, srv.fetchImpl);
  const item = items.find((i) => i.shareId === created.id);
  expect(item?.title).toBe(TITLE);
});

test("history item carries the content-key fragment to rebuild the openable share link", async () => {
  const srv = makeFakeServer();
  const { account } = await setupAccountFlow(PASS, srv.fetchImpl);

  const created = await createSharedToHistory(
    "session line",
    account.accountKey,
    { origin: "https://x.test" },
    srv.fetchImpl,
  );

  const items = await fetchHistoryDecrypted(account.accountKey, srv.fetchImpl);
  const item = items.find((i) => i.shareId === created.id);

  // The link the History panel rebuilds must equal the original openable link:
  // the fragment carries the decryption key, without which the viewer 404s on "no-key".
  const fragment = created.link.split("#key=")[1];
  expect(item?.keyFragment).toBe(fragment);
  expect(`https://x.test/s/${item?.shareId}#key=${item?.keyFragment}`).toBe(created.link);
});

test("reconcile adds an anonymous share to history", async () => {
  const srv = makeFakeServer();
  const { account } = await setupAccountFlow(PASS, srv.fetchImpl);
  const key = await generateContentKey();
  expect(await reconcileLocalShare("a".repeat(43), key, account.accountKey, srv.fetchImpl)).toBe(
    true,
  );
});

test("deleteHistoryEntry removes only the targeted entry from history", async () => {
  const srv = makeFakeServer();
  const { account } = await setupAccountFlow(PASS, srv.fetchImpl);
  await createSharedToHistory("payload one", account.accountKey, { title: "one" }, srv.fetchImpl);
  await createSharedToHistory("payload two", account.accountKey, { title: "two" }, srv.fetchImpl);

  const before = await fetchHistoryDecrypted(account.accountKey, srv.fetchImpl);
  expect(before.length).toBe(2);

  await deleteHistoryEntry(before[0]!.shareId, srv.fetchImpl);

  const after = await fetchHistoryDecrypted(account.accountKey, srv.fetchImpl);
  expect(after.map((h) => h.shareId)).toEqual([before[1]!.shareId]);
});

test("deleteHistoryEntry throws on a non-ok response", async () => {
  const failing = (async (_url: string, _init?: RequestInit) =>
    new Response("nope", { status: 500 })) as typeof fetch;
  await expect(deleteHistoryEntry("a".repeat(43), failing)).rejects.toThrow();
});

// --- U6: unified history decrypt (web + CLI uploads) ---

// Build a CLI-upload history item: content key wrapped under a machine key, the
// machine key wrapped under the account key (the shape handleListHistory emits).
async function makeCliItem(
  accountKey: CryptoKey,
  tokenId: string,
  shareId: string,
  title: string | null,
  machineKey?: CryptoKey,
) {
  const mk = machineKey ?? (await generateMachineKey());
  const wrappedMachineKey = await wrapMachineKey(accountKey, mk);
  const contentKey = await generateContentKey();
  const wrappedContentKey = await wrapContentKey(mk, contentKey);
  const encryptedTitle = title
    ? JSON.stringify(await encryptSession(title, contentKey, shareId))
    : null;
  return {
    shareId,
    wrappedContentKey,
    cliTokenId: tokenId,
    wrappedMachineKey,
    encryptedTitle,
    sizeBytes: 1,
    createdAt: "now",
    expiresAt: null,
    state: "active",
  };
}

async function makeWebItem(accountKey: CryptoKey, shareId: string, title: string | null) {
  const contentKey = await generateContentKey();
  const wrappedContentKey = await wrapContentKey(accountKey, contentKey);
  const encryptedTitle = title
    ? JSON.stringify(await encryptSession(title, contentKey, shareId))
    : null;
  return {
    shareId,
    wrappedContentKey,
    cliTokenId: null,
    wrappedMachineKey: null,
    encryptedTitle,
    sizeBytes: 1,
    createdAt: "now",
    expiresAt: null,
    state: "active",
  };
}

function historyServer(items: any[]): typeof fetch {
  return (async (url: string) => {
    if (String(url) === "/api/history") return jsonRes({ items });
    return jsonRes({ error: "not_found" }, 404);
  }) as typeof fetch;
}

test("AE4: a mixed web + CLI history decrypts both, with openable fragments", async () => {
  const { account } = await setupAccountFlow(PASS, makeFakeServer().fetchImpl);
  const web = await makeWebItem(account.accountKey, "w".repeat(43), "Web Title");
  const cli = await makeCliItem(account.accountKey, "tok-1", "c".repeat(43), "CLI Title");

  const items = await fetchHistoryDecrypted(account.accountKey, historyServer([web, cli]));
  const byId = Object.fromEntries(items.map((i) => [i.shareId, i]));
  expect(byId["w".repeat(43)]!.title).toBe("Web Title");
  expect(byId["c".repeat(43)]!.title).toBe("CLI Title");
  // both rebuild an openable key fragment
  expect(byId["w".repeat(43)]!.keyFragment).toBeTruthy();
  expect(byId["c".repeat(43)]!.keyFragment).toBeTruthy();
});

test("two CLI uploads under one token both decrypt (shared machine key)", async () => {
  const { account } = await setupAccountFlow(PASS, makeFakeServer().fetchImpl);
  const mk = await generateMachineKey();
  const a = await makeCliItem(account.accountKey, "tok-x", "a".repeat(43), "A", mk);
  const b = await makeCliItem(account.accountKey, "tok-x", "b".repeat(43), "B", mk);

  const items = await fetchHistoryDecrypted(account.accountKey, historyServer([a, b]));
  expect(items.find((i) => i.shareId === "a".repeat(43))!.title).toBe("A");
  expect(items.find((i) => i.shareId === "b".repeat(43))!.title).toBe("B");
});

test("a garbled machine key leaves only its items undecrypted; siblings still render", async () => {
  const { account } = await setupAccountFlow(PASS, makeFakeServer().fetchImpl);
  const web = await makeWebItem(account.accountKey, "w".repeat(43), "Still Here");
  const cli = await makeCliItem(account.accountKey, "tok-bad", "c".repeat(43), "Lost");
  // corrupt the wrapped machine key so it can't be unwrapped
  cli.wrappedMachineKey = { iv: "AAAA", ct: "BBBB" };

  const items = await fetchHistoryDecrypted(account.accountKey, historyServer([web, cli]));
  expect(items.find((i) => i.shareId === "w".repeat(43))!.title).toBe("Still Here");
  const lost = items.find((i) => i.shareId === "c".repeat(43))!;
  expect(lost.title).toBeNull();
  expect(lost.keyFragment).toBeNull();
});

test("saveToHistory uploads ciphertext + a private flag + a wrapped key, no plaintext", async () => {
  const srv = makeFakeServer();
  const { account } = await setupAccountFlow(PASS, srv.fetchImpl);

  const SESSION = "TOP SECRET private session";
  const out = await saveToHistory(SESSION, account.accountKey, { title: "Draft" }, srv.fetchImpl);

  const upload = srv.lastUpload();
  expect(upload.private).toBe(true);
  expect(upload.wrappedContentKey).toBeTruthy();
  expect(JSON.stringify(upload)).not.toContain("TOP SECRET");
  expect(JSON.stringify(upload)).not.toContain("Draft");
  expect(out.id).toBe(upload.id);
  expect(out.keyFragment).toBeTruthy();
});

test("setHistoryShareState PATCHes the chosen state to the right entry", async () => {
  let captured: { url: string; method?: string; body: any } | null = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : null };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await setHistoryShareState("a".repeat(43), "active", fetchImpl);
  expect(captured!.url).toBe(`/api/history/${"a".repeat(43)}`);
  expect(captured!.method).toBe("PATCH");
  expect(captured!.body).toEqual({ state: "active" });
});

test("setHistoryShareState throws on a non-ok response", async () => {
  const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  await expect(setHistoryShareState("a".repeat(43), "private", failing)).rejects.toThrow();
});

test("renameHistoryEntry PATCHes a title encrypted under the content key from the fragment", async () => {
  const srv = makeFakeServer();
  const { account } = await setupAccountFlow(PASS, srv.fetchImpl);
  const saved = await saveToHistory("session body", account.accountKey, {}, srv.fetchImpl);

  let captured: any = null;
  const patchImpl = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), body: init?.body ? JSON.parse(init.body as string) : null };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await renameHistoryEntry(saved.id, saved.keyFragment, "Renamed Title", patchImpl);
  expect(captured.url).toBe(`/api/history/${saved.id}`);
  expect(typeof captured.body.encryptedTitle).toBe("string");

  // the PATCHed ciphertext decrypts back to the new title under the content key
  const key = await importKeyFromFragment(saved.keyFragment);
  const env = JSON.parse(captured.body.encryptedTitle);
  expect(await decryptSession(env, key, saved.id)).toBe("Renamed Title");
});
