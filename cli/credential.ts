// CLI credential file storage (plan U7). The compound credential carries a
// decryption key, so the file is written owner-only (0600) inside an owner-only
// dir (0700), created atomically (O_CREAT|O_EXCL, never write-then-chmod) and
// rename()'d into place so there is never a world-readable window.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  constants,
} from "node:fs";

/** `$XDG_CONFIG_HOME/jsonl-tools` or `~/.config/jsonl-tools`. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "jsonl-tools");
}

export function credentialPath(dir = configDir()): string {
  return join(dir, "credentials");
}

/**
 * Write the credential to a 0600 file. Ensures the parent dir is 0700, refusing a
 * pre-existing dir whose permissions are looser than owner-only rather than
 * writing a secret into a readable location.
 */
export function writeCredential(raw: string, dir = configDir()): void {
  try {
    const st = statSync(dir);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `Config dir ${dir} is not private (expected chmod 700). Tighten it or remove it, then retry.`,
      );
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else throw e;
  }

  const target = credentialPath(dir);
  const tmp = join(dir, `.credentials.tmp-${process.pid}`);
  const noFollow = (constants as any).O_NOFOLLOW ?? 0;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
  let fd: number;
  try {
    fd = openSync(tmp, flags, 0o600);
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      unlinkSync(tmp); // stale temp from a crashed run
      fd = openSync(tmp, flags, 0o600);
    } else {
      throw e;
    }
  }
  try {
    writeSync(fd, raw.trim() + "\n");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target); // atomic replace
}

/** Read the stored credential, or null if none exists. */
export function readCredential(dir = configDir()): string | null {
  try {
    return readFileSync(credentialPath(dir), "utf8").trim() || null;
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
