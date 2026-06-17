// Compound CLI credential encode/parse (plan U5). PURE string logic — no Web
// Crypto, no node APIs — so it is safe to import from both the browser bundle
// (account.tsx, where it is assembled at mint time) and the CLI (where it is
// parsed). The browser boundary test reaches this module; keep it dependency-free.
//
// A credential bundles three parts the operator copies to a box:
//   - tokenId   : non-secret lookup id (sent to the server)
//   - authSecret: the secret half (sent in the Authorization header, hashed server-side)
//   - machineKey: raw AES key bytes (base64url) — NEVER sent to the server; the box
//                 uses it to wrap/unwrap content keys locally.
// The wire format is `jt1_<tokenId>.<authSecret>.<machineKey>`. The Authorization
// header carries only `<tokenId>.<authSecret>` (see bearerFromCredential).

const PREFIX = "jt1_";

export interface CliCredential {
  tokenId: string;
  authSecret: string;
  /** raw machine-key bytes, base64url — stays on the box */
  machineKey: string;
}

const PART_RE = /^[A-Za-z0-9_-]+$/;

/** Assemble the opaque credential string shown once in the web app. */
export function encodeCredential(c: CliCredential): string {
  return `${PREFIX}${c.tokenId}.${c.authSecret}.${c.machineKey}`;
}

/** Parse a credential string, or null if it is malformed. */
export function parseCredential(raw: string): CliCredential | null {
  const s = raw.trim();
  if (!s.startsWith(PREFIX)) return null;
  const parts = s.slice(PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const [tokenId, authSecret, machineKey] = parts as [string, string, string];
  if (!tokenId || !authSecret || !machineKey) return null;
  if (!PART_RE.test(tokenId) || !PART_RE.test(authSecret) || !PART_RE.test(machineKey)) {
    return null;
  }
  return { tokenId, authSecret, machineKey };
}

/** The `Authorization: Bearer` value — only the id + secret, never the machine key. */
export function bearerFromCredential(c: CliCredential): string {
  return `${c.tokenId}.${c.authSecret}`;
}
