import { test, expect } from "bun:test";
import { toDataRows } from "./data-view-core";

test("empty or whitespace-only source yields no rows", () => {
  expect(toDataRows("")).toEqual([]);
  expect(toDataRows("   \n  ")).toEqual([]);
});

test("one row per line, numbered from 1", () => {
  expect(toDataRows('{"a":1}\n{"b":2}')).toEqual([
    { line: 1, data: { a: 1 } },
    { line: 2, data: { b: 2 } },
  ]);
});

test("blank lines are skipped and do not consume a line number", () => {
  expect(toDataRows('{"a":1}\n\n{"b":2}')).toEqual([
    { line: 1, data: { a: 1 } },
    { line: 2, data: { b: 2 } },
  ]);
});

test("a malformed line is preserved as { raw } instead of dropped", () => {
  expect(toDataRows('{"a":1}\nnot json\n{"b":2}')).toEqual([
    { line: 1, data: { a: 1 } },
    { line: 2, data: { raw: "not json" } },
    { line: 3, data: { b: 2 } },
  ]);
});
