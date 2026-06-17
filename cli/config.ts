// CLI config resolution (plan U7). Base URL and credential are resolved with
// precedence flag > env > stored file. A non-HTTPS base URL is refused unless
// --allow-insecure is passed: the credential carries a decryption key, so a
// cleartext endpoint would leak it.

import { parseCredential, type CliCredential } from "../src/cli-credential";
import { readCredential } from "./credential";

export const DEFAULT_BASE_URL = "https://jsonl-tools.dev";

export interface ConfigOpts {
  baseUrl?: string;
  token?: string;
  allowInsecure?: boolean;
}

/** Resolve and validate the base URL (flag > env > default; HTTPS enforced). */
export function resolveBaseUrl(
  opts: ConfigOpts,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = opts.baseUrl ?? env.JSONL_TOOLS_URL ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid base URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !opts.allowInsecure) {
    throw new Error(
      `Refusing a non-HTTPS base URL (${raw}). The credential carries a decryption ` +
        `key — pass --allow-insecure for local development only.`,
    );
  }
  return url.origin;
}

/**
 * Resolve the credential (flag > env > stored file). Returns null when no source
 * is present (the caller prompts to run `login`); throws when a source exists but
 * is malformed.
 */
export function resolveCredential(
  opts: ConfigOpts,
  env: NodeJS.ProcessEnv = process.env,
  readFile: () => string | null = readCredential,
): CliCredential | null {
  const raw = opts.token ?? env.JSONL_TOOLS_TOKEN ?? readFile();
  if (!raw) return null;
  const cred = parseCredential(raw);
  if (!cred) {
    throw new Error("Credential is malformed — re-run `jsonl-tools login`.");
  }
  return cred;
}
