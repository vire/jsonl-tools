import React, { useState, useRef, useEffect, useCallback } from "react";
import { domToPng } from "modern-screenshot";
import JsonView from "@uiw/react-json-view";
import { jsonViewStyle } from "./json-view-style";
import "./entry-table.css";

export interface ParsedEntry {
  timestamp?: string;
  type?: string;
  operation?: string;
  message?: {
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          name?: string;
          id?: string;
          tool_use_id?: string;
        }>;
  };
  subtype?: string;
  error?: string;
  [key: string]: unknown;
}

export function parseJsonl(text: string): ParsedEntry[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
});

function formatTime(d: Date): string {
  return dateFmt.format(d);
}

function computeDelta(
  ts: Date | null,
  prevTs: Date | null,
): { label: string; cls: string } {
  if (!ts || !prevTs) return { label: "\u2013", cls: "delta-fast" };
  const diffMs = ts.getTime() - prevTs.getTime();
  const label =
    diffMs < 1000 ? diffMs + "ms" : (diffMs / 1000).toFixed(2) + "s";
  const cls =
    diffMs < 1000 ? "delta-fast" : diffMs < 10000 ? "delta-medium" : "delta-slow";
  return { label, cls };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function describeEntry(entry: ParsedEntry): React.ReactNode {
  const type = entry.type;

  if (type === "queue-operation") {
    return entry.operation || "queue-operation";
  }

  if (type === "user") {
    const msg = entry.message;
    if (!msg) return "user message";
    const content = msg.content;
    if (typeof content === "string") return "user message";
    if (Array.isArray(content)) {
      return content.map((block, i) => {
        const sep = i < content.length - 1 ? ", " : "";
        if (block.type === "tool_result") {
          return (
            <span key={i}>
              Tool result (<span className="tool-id">{block.tool_use_id || ""}</span>)
              {sep}
            </span>
          );
        }
        if (block.type === "text") return <span key={i}>text{sep}</span>;
        return (
          <span key={i}>
            {block.type || "?"}
            {sep}
          </span>
        );
      });
    }
    return "user message";
  }

  if (type === "assistant") {
    const msg = entry.message;
    if (!msg) return "assistant";
    const content = msg.content;
    if (typeof content === "string") {
      return <>text: &quot;{truncate(content, 120)}&quot;</>;
    }
    if (Array.isArray(content)) {
      return content.map((block, i) => {
        if (block.type === "text") {
          return (
            <div key={i}>
              text: &quot;{truncate(block.text || "", 120)}&quot;
            </div>
          );
        }
        if (block.type === "tool_use") {
          return (
            <div key={i}>
              <span className="tool-name">{block.name || "tool"}</span>{" "}
              (<span className="tool-id">{block.id || ""}</span>)
            </div>
          );
        }
        return <div key={i}>{block.type || "?"}</div>;
      });
    }
    return "assistant";
  }

  if (type === "result") {
    const subtype = entry.subtype || "";
    if (subtype === "success") return "Result: success";
    if (subtype === "error")
      return "Result: error - " + truncate(entry.error || "", 120);
    return "Result: " + subtype;
  }

  return JSON.stringify(entry).slice(0, 200);
}

const entryJsonStyle = jsonViewStyle("12px");

// A small "Copy As ▾" / "Download As ▾" menu: a trigger styled as a snapshot
// button plus a popover of format choices. Closes on outside click or Escape.
export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="btn-snapshot"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span className="menu-caret">▾</span>
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EntryTable({
  entries,
  source,
}: {
  entries: ParsedEntry[];
  // Raw session text, used verbatim for "JSONL" export. When omitted it is
  // reconstructed from the parsed entries (one compact JSON object per line).
  source?: string;
}) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const capture = useCallback(async (): Promise<Blob | null> => {
    if (!tableRef.current) return null;
    const dataUrl = await domToPng(tableRef.current, {
      backgroundColor: "#0d1421",
      scale: 2,
      style: { padding: "16px" },
    });
    const res = await fetch(dataUrl);
    return res.blob();
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      setSnapshotStatus("Copying...");
      const blob = await capture();
      if (!blob) return;
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setSnapshotStatus("Copied!");
    } catch (e) {
      console.error(e);
      setSnapshotStatus("Copy failed");
    } finally {
      setTimeout(() => setSnapshotStatus(null), 2000);
    }
  }, [capture]);

  const handleDownload = useCallback(async () => {
    try {
      setSnapshotStatus("Generating...");
      const blob = await capture();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "session.png";
      a.click();
      URL.revokeObjectURL(url);
      setSnapshotStatus("Downloaded!");
    } catch (e) {
      console.error(e);
      setSnapshotStatus("Download failed");
    } finally {
      setTimeout(() => setSnapshotStatus(null), 2000);
    }
  }, [capture]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSnapshotStatus("Copied!");
    } catch {
      setSnapshotStatus("Copy failed");
    } finally {
      setTimeout(() => setSnapshotStatus(null), 2000);
    }
  }, []);

  const downloadText = useCallback(
    (text: string, filename: string, mime: string) => {
      try {
        const url = URL.createObjectURL(new Blob([text], { type: mime }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setSnapshotStatus("Downloaded!");
      } catch {
        setSnapshotStatus("Download failed");
      } finally {
        setTimeout(() => setSnapshotStatus(null), 2000);
      }
    },
    [],
  );

  // JSONL preserves the original bytes when available; JSON is a pretty-printed
  // array of the same objects the table renders.
  const jsonlText =
    source ?? entries.map((e) => JSON.stringify(e)).join("\n");
  const jsonText = JSON.stringify(entries, null, 2);

  const rows = entries.map((entry, i) => {
    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
    // Look back to the most recent entry that has a timestamp
    let prevTs: Date | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j]!.timestamp) {
        prevTs = new Date(entries[j]!.timestamp!);
        break;
      }
    }
    return { entry, ts, prevTs, index: i };
  });

  const firstTs = rows.find((r) => r.ts)?.ts ?? null;
  const lastTs = rows.findLast((r) => r.ts)?.ts ?? null;
  const totalDuration =
    firstTs && lastTs && firstTs !== lastTs
      ? ((lastTs.getTime() - firstTs.getTime()) / 1000).toFixed(1) + "s"
      : "-";

  const toggleRow = (index: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <>
      <div className="table-toolbar">
        <div className="summary">
          <span>
            Entries: <strong>{entries.length}</strong>
          </span>
          <span>
            Duration: <strong>{totalDuration}</strong>
          </span>
        </div>
        <div className="snapshot-actions">
          {snapshotStatus && (
            <span className="snapshot-status">{snapshotStatus}</span>
          )}
          <Menu
            label="Copy As"
            items={[
              { key: "jsonl", label: "JSONL", onSelect: () => copyText(jsonlText) },
              { key: "json", label: "JSON", onSelect: () => copyText(jsonText) },
              { key: "png", label: "PNG", onSelect: handleCopy },
            ]}
          />
          <Menu
            label="Download As"
            items={[
              {
                key: "jsonl",
                label: "JSONL",
                onSelect: () =>
                  downloadText(jsonlText, "session.jsonl", "application/x-ndjson"),
              },
              {
                key: "json",
                label: "JSON",
                onSelect: () =>
                  downloadText(jsonText, "session.json", "application/json"),
              },
              { key: "png", label: "PNG", onSelect: handleDownload },
            ]}
          />
        </div>
      </div>
      <div ref={tableRef}>
      <table className="entry-table">
        <thead>
          <tr>
            <th className="col-ts">Timestamp</th>
            <th className="col-delta">Delta</th>
            <th className="col-type">Type</th>
            <th className="col-desc">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, ts, prevTs, index }) => {
            const timestamp = ts ? formatTime(ts) : "-";
            const { label: delta, cls: deltaCls } = computeDelta(ts, prevTs);
            const type = entry.type || "unknown";
            const typeCls =
              type === "user"
                ? "type-user"
                : type === "assistant"
                  ? "type-assistant"
                  : type === "queue-operation"
                    ? "type-queue"
                    : "type-other";

            return (
              <tr key={index}>
                <td className="col-ts">{timestamp}</td>
                <td className={`col-delta ${deltaCls}`}>{delta}</td>
                <td className={`col-type ${typeCls}`}>{type}</td>
                <td className="col-desc">
                  <div
                    className="desc-text"
                    onClick={() => toggleRow(index)}
                  >
                    {describeEntry(entry)}
                  </div>
                  {expandedRows.has(index) && (
                    <div className="desc-json" onClick={(e) => e.stopPropagation()}>
                      <JsonView
                        value={entry as Record<string, unknown>}
                        style={entryJsonStyle}
                        shortenTextAfterLength={120}
                        displayDataTypes={false}
                        displayObjectSize={false}
                        enableClipboard={false}
                        collapsed={7}
                      />
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}
