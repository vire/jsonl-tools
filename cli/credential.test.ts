import { test, expect, afterEach } from "bun:test";
import { writeCredential, readCredential } from "./credential";
import { mkdtempSync, rmSync, statSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "jt-cred-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("writes the credential 0600 inside a 0700 dir and round-trips", () => {
  const base = scratch();
  const dir = join(base, "cfg");
  writeCredential("jt1_a.b.c", dir);

  expect(readCredential(dir)).toBe("jt1_a.b.c");
  expect(statSync(join(dir, "credentials")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("re-login overwrites atomically (no leftover temp, new value wins)", () => {
  const base = scratch();
  const dir = join(base, "cfg");
  writeCredential("jt1_a.b.c", dir);
  writeCredential("jt1_d.e.f", dir);
  expect(readCredential(dir)).toBe("jt1_d.e.f");
});

test("refuses to write into a pre-existing dir with looser-than-0700 perms", () => {
  const base = scratch();
  const dir = join(base, "loose");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755); // ensure group/other bits despite umask
  expect(() => writeCredential("jt1_a.b.c", dir)).toThrow(/not private/);
});

test("reading a missing credential returns null", () => {
  const base = scratch();
  expect(readCredential(join(base, "nope"))).toBeNull();
});
