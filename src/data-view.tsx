import { useCallback, useMemo, useState } from "react";
import JsonView from "@uiw/react-json-view";
import { toDataRows } from "./data-view-core";
import { jsonViewStyle } from "./json-view-style";
import { Menu } from "./entry-table";
import "./entry-table.css";

const dataViewStyle = jsonViewStyle("16px");

// The "data view": each source line as an expandable JSON tree, numbered in the
// left gutter. Shared by the main app's "View" button and the share viewer's
// Data tab so the two stay in lock-step. The share viewer opts into a "Copy As"
// toolbar (showCopyAs) that mirrors the Table view's; the main app keeps its own
// top-level copy controls and leaves it off.
export function DataView({
  source,
  showCopyAs = false,
}: {
  source: string;
  showCopyAs?: boolean;
}) {
  const rows = useMemo(() => toDataRows(source), [source]);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Copied!");
    } catch {
      setCopyStatus("Copy failed");
    } finally {
      setTimeout(() => setCopyStatus(null), 2000);
    }
  }, []);

  // JSONL is the raw source verbatim (same bytes the Table view exports); JSON is
  // a pretty-printed array of exactly the rows shown, including any raw-wrapped
  // unparseable lines.
  const jsonText = useMemo(
    () => JSON.stringify(rows.map((r) => r.data), null, 2),
    [rows],
  );

  return (
    <>
      {showCopyAs && (
        <div className="table-toolbar" style={{ justifyContent: "flex-end" }}>
          <div className="snapshot-actions">
            {copyStatus && (
              <span className="snapshot-status">{copyStatus}</span>
            )}
            <Menu
              label="Copy As"
              items={[
                {
                  key: "jsonl",
                  label: "JSONL",
                  onSelect: () => copyText(source),
                },
                {
                  key: "json",
                  label: "JSON",
                  onSelect: () => copyText(jsonText),
                },
              ]}
            />
          </div>
        </div>
      )}
      <table className="viewer-table">
        <colgroup>
          <col style={{ width: "50px" }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th>Content</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line}>
              <td className="line-number">{row.line}</td>
              <td className="json-content">
                <JsonView
                  value={row.data}
                  style={dataViewStyle}
                  shortenTextAfterLength={120}
                  displayDataTypes={false}
                  displayObjectSize={false}
                  enableClipboard={false}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default DataView;
