// CLI command logic (plan U8). Pure-ish: every function takes an injectable
// fetch + base URL + credential, so the whole upload/download/view round-trip is
// testable against an in-memory server with no real network or filesystem.
//
// Reuses the app's WebCrypto verbatim: the content key is wrapped under this
// box's machine key (from the credential), so the server only ever sees
// ciphertext and the web app decrypts the same uploads under the account key.

import {
  generateShareId,
  generateContentKey,
  encryptSession,
  decryptSession,
  exportKeyToFragment,
  type ShareEnvelope,
} from "../src/share-crypto";
import {
  importMachineKeyRaw,
  wrapContentKey,
  unwrapContentKey,
} from "../src/account-crypto";
import { bearerFromCredential, type CliCredential } from "../src/cli-credential";
import type { CliUploadSummary } from "../src/wire-types";

/** Ciphertext ceiling — mirrors MAX_CIPHERTEXT_BYTES on the server. */
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

/** Default per-request timeout — generous so a 25MB upload on a slow link survives. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface Deps {
  baseUrl: string;
  credential: CliCredential;
  fetchImpl?: typeof fetch;
  /** per-request timeout in ms; bounds a stalled server (default 120s). */
  timeoutMs?: number;
}

function headers(cred: CliCredential): Record<string, string> {
  return {
    authorization: `Bearer ${bearerFromCredential(cred)}`,
    "content-type": "application/json",
  };
}
const doFetch = (d: Deps): typeof fetch => d.fetchImpl ?? fetch;
/** Merge an AbortSignal.timeout into a request so the CLI never hangs forever. */
function withTimeout(d: Deps, init: RequestInit = {}): RequestInit {
  return { ...init, signal: AbortSignal.timeout(d.timeoutMs ?? DEFAULT_TIMEOUT_MS) };
}

/**
 * Upload one JSONL payload. Size-checks the plaintext before encrypting and
 * errors with the filename and limit on overflow (the server's hard ceiling is
 * the backstop). Returns the new share id.
 */
export async function uploadContent(
  deps: Deps,
  opts: { filename: string; content: string; title?: string | null },
): Promise<{ id: string }> {
  const bytes = Buffer.byteLength(opts.content, "utf8");
  if (bytes + 16 > MAX_CONTENT_BYTES) {
    throw new Error(
      `${opts.filename} is ${bytes} bytes, over the ${MAX_CONTENT_BYTES}-byte limit. Split the file or remove lines.`,
    );
  }

  const machineKey = await importMachineKeyRaw(deps.credential.machineKey);
  const id = generateShareId();
  const contentKey = await generateContentKey();
  const env = await encryptSession(opts.content, contentKey, id);
  const wrappedContentKey = await wrapContentKey(machineKey, contentKey);
  const encryptedTitle = opts.title
    ? JSON.stringify(await encryptSession(opts.title, contentKey, id))
    : null;

  const res = await doFetch(deps)(
    `${deps.baseUrl}/api/cli/uploads`,
    withTimeout(deps, {
      method: "POST",
      headers: headers(deps.credential),
      body: JSON.stringify({
        id,
        v: env.v,
        iv: env.iv,
        ct: env.ct,
        encryptedTitle,
        wrappedContentKey,
      }),
    }),
  );
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status}).`);
  return { id };
}

/** List this box's uploads (token-scoped). */
export async function listUploads(deps: Deps): Promise<CliUploadSummary[]> {
  const res = await doFetch(deps)(
    `${deps.baseUrl}/api/cli/uploads`,
    withTimeout(deps, { headers: headers(deps.credential) }),
  );
  if (!res.ok) throw new Error(`List failed (HTTP ${res.status}).`);
  const { items } = (await res.json()) as { items: CliUploadSummary[] };
  return items;
}

/**
 * Fetch + decrypt one upload's JSONL. The content key never leaves this process.
 * Pass a pre-imported `machineKey` to avoid re-importing it for every item in a
 * bulk download.
 */
export async function downloadOne(
  deps: Deps,
  item: CliUploadSummary,
  machineKey?: CryptoKey,
): Promise<string> {
  const mk = machineKey ?? (await importMachineKeyRaw(deps.credential.machineKey));
  const res = await doFetch(deps)(
    `${deps.baseUrl}/api/shares/${item.shareId}`,
    withTimeout(deps),
  );
  if (!res.ok) throw new Error(`Share ${item.shareId} is unavailable (HTTP ${res.status}).`);
  const env = (await res.json()) as ShareEnvelope;
  const contentKey = await unwrapContentKey(mk, item.wrappedContentKey);
  return decryptSession(env, contentKey, item.shareId);
}

export interface FileSink {
  exists(name: string): boolean;
  write(name: string, content: string): void;
}

/** Pick a non-colliding filename by appending -1, -2, … (never silently overwrite). */
export function uniqueName(base: string, sink: FileSink): string {
  if (!sink.exists(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 1;
  while (sink.exists(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

export interface DownloadResult {
  written: string[];
  failed: { shareId: string; error: string }[];
}

/**
 * Download all active uploads into a sink, never overwriting existing files. A
 * single failed item (a transient error, or a share tombstoned between the list
 * and the fetch) does NOT abort the batch — successes are written and failures
 * are returned so the caller can report them.
 */
export async function downloadAll(deps: Deps, sink: FileSink): Promise<DownloadResult> {
  const items = (await listUploads(deps)).filter((i) => i.state === "active");
  // Import the box machine key once, fetch + decrypt all items concurrently, then
  // write sequentially so uniqueName collision handling stays deterministic.
  const machineKey = await importMachineKeyRaw(deps.credential.machineKey);
  const results = await Promise.allSettled(items.map((i) => downloadOne(deps, i, machineKey)));

  const written: string[] = [];
  const failed: { shareId: string; error: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      const name = uniqueName(`${items[i]!.shareId}.jsonl`, sink);
      sink.write(name, r.value);
      written.push(name);
    } else {
      failed.push({ shareId: items[i]!.shareId, error: (r.reason as Error).message });
    }
  }
  return { written, failed };
}

/**
 * Build the openable viewer link for one upload. Resolves the content key locally
 * and places it in the URL fragment — it is never sent to the server.
 */
export async function viewLink(deps: Deps, item: CliUploadSummary): Promise<string> {
  const machineKey = await importMachineKeyRaw(deps.credential.machineKey);
  const contentKey = await unwrapContentKey(machineKey, item.wrappedContentKey);
  const fragment = await exportKeyToFragment(contentKey);
  return `${deps.baseUrl}/s/${item.shareId}#key=${fragment}`;
}

/** Tombstone one upload by id. */
export async function deleteUpload(deps: Deps, shareId: string): Promise<void> {
  const res = await doFetch(deps)(
    `${deps.baseUrl}/api/cli/uploads/${encodeURIComponent(shareId)}`,
    withTimeout(deps, { method: "DELETE", headers: headers(deps.credential) }),
  );
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status}).`);
}
