import type { CSSProperties } from "react";

// Shared @uiw/react-json-view theme so the data view, the durations table's
// expanded rows, and the main app all render JSON identically. Only the font
// size differs between call sites, so it's the one parameter.
export function jsonViewStyle(fontSize: string): CSSProperties {
  return {
    fontSize,
    fontWeight: "400",
    "--w-rjv-color": "#aaaaaa",
    // Keys read in the cyan interactive accent; string values in brand violet
    // (matches the themed design's keys-cyan / strings-violet split).
    "--w-rjv-key-number": "#1ba6c9",
    "--w-rjv-key-string": "#1ba6c9",
    "--w-rjv-background-color": "transparent",
    "--w-rjv-line-color": "#6b789280",
    "--w-rjv-arrow-color": "#6b7892",
    "--w-rjv-edit-color": "#1ba6c9",
    "--w-rjv-info-color": "#6b78927a",
    "--w-rjv-update-color": "#1ba6c9",
    "--w-rjv-copied-color": "#1ba6c9",
    "--w-rjv-copied-success-color": "#98c379",
    "--w-rjv-curlybraces-color": "#aaaaaa",
    "--w-rjv-colon-color": "#6b7892",
    "--w-rjv-brackets-color": "#aaaaaa",
    "--w-rjv-ellipsis-color": "#8b95ad",
    "--w-rjv-quotes-color": "#6b7892",
    "--w-rjv-quotes-string-color": "#9b86f5",
    "--w-rjv-type-string-color": "#9b86f5",
    "--w-rjv-type-int-color": "#d19a66",
    "--w-rjv-type-float-color": "#d19a66",
    "--w-rjv-type-bigint-color": "#d19a66",
    "--w-rjv-type-boolean-color": "#c678dd",
    "--w-rjv-type-date-color": "#8b95ad",
    "--w-rjv-type-url-color": "#1ba6c9",
    "--w-rjv-type-null-color": "#ff6b6b",
    "--w-rjv-type-nan-color": "#8b95ad",
    "--w-rjv-type-undefined-color": "#ff6b6b",
  } as CSSProperties;
}
