// Pure logic for the "data view": one row per non-blank source line, each line
// parsed independently so a single malformed line can't sink the rest. Lives in
// its own module (no React) so it stays unit-testable — mirrors the
// share-viewer-core / share-viewer split.

export interface DataRow {
  line: number;
  // Whatever the line parses to. A line that isn't valid JSON is preserved as
  // { raw: <line> } so nothing is silently dropped.
  data: object;
}

export function toDataRows(source: string): DataRow[] {
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return { line: i + 1, data: JSON.parse(line) as object };
      } catch {
        return { line: i + 1, data: { raw: line } };
      }
    });
}
