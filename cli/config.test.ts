import { test, expect } from "bun:test";
import { resolveBaseUrl, resolveCredential, DEFAULT_BASE_URL } from "./config";
import { encodeCredential } from "../src/cli-credential";

const CRED = encodeCredential({ tokenId: "t", authSecret: "s", machineKey: "mk" });

test("base URL defaults, honors flag/env, and enforces HTTPS", () => {
  expect(resolveBaseUrl({}, {} as any)).toBe(DEFAULT_BASE_URL);
  expect(resolveBaseUrl({ baseUrl: "https://self.host" }, {} as any)).toBe("https://self.host");
  expect(resolveBaseUrl({}, { JSONL_TOOLS_URL: "https://env.host" } as any)).toBe("https://env.host");
  // flag beats env
  expect(resolveBaseUrl({ baseUrl: "https://flag.host" }, { JSONL_TOOLS_URL: "https://env.host" } as any)).toBe(
    "https://flag.host",
  );
  // non-HTTPS refused unless --allow-insecure
  expect(() => resolveBaseUrl({ baseUrl: "http://local" }, {} as any)).toThrow(/non-HTTPS/);
  expect(resolveBaseUrl({ baseUrl: "http://local", allowInsecure: true }, {} as any)).toBe("http://local");
});

test("credential precedence is flag > env > file", () => {
  const fileCred = () => CRED;
  // flag wins
  const flagCred = encodeCredential({ tokenId: "flag", authSecret: "s", machineKey: "mk" });
  expect(resolveCredential({ token: flagCred }, { JSONL_TOOLS_TOKEN: CRED } as any, fileCred)!.tokenId).toBe("flag");
  // env beats file
  const envCred = encodeCredential({ tokenId: "env", authSecret: "s", machineKey: "mk" });
  expect(resolveCredential({}, { JSONL_TOOLS_TOKEN: envCred } as any, fileCred)!.tokenId).toBe("env");
  // file is the fallback
  expect(resolveCredential({}, {} as any, fileCred)!.tokenId).toBe("t");
});

test("no credential anywhere returns null; a malformed one throws", () => {
  expect(resolveCredential({}, {} as any, () => null)).toBeNull();
  expect(() => resolveCredential({ token: "garbage" }, {} as any, () => null)).toThrow(/malformed/);
});
