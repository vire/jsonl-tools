import { useState, useRef, useCallback, useEffect } from "react";
import { EntryTable, parseJsonl, type ParsedEntry } from "./entry-table";
import { fetchWithSession } from "./session-id";
import "./bulk-analyzer.css";

interface FileData {
  name: string;
  entries: ParsedEntry[];
}

/* ── main component ── */

export function BulkAnalyzerApp() {
  const [files, setFiles] = useState<Map<string, FileData>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Page-view ping: the bulk-analyzer (R22-exempt) fires no other /api call on
  // load, so it records its own page-view via this beacon (KTD2). Best-effort.
  useEffect(() => {
    fetchWithSession("/api/events", { method: "POST" }, "bulk-analyzer").catch(() => {});
  }, []);

  const addFile = useCallback(
    (name: string, entries: ParsedEntry[]) => {
      const id = name + "_" + Date.now();
      setFiles((prev) => {
        const next = new Map(prev);
        next.set(id, { name, entries });
        return next;
      });
      setActiveTab(id);
    },
    [],
  );

  const handleFiles = useCallback(
    (fileList: FileList) => {
      for (const file of fileList) {
        if (!file.name.endsWith(".jsonl")) continue;
        file.text().then((text) => {
          const entries = parseJsonl(text);
          addFile(file.name, entries);
        });
      }
    },
    [addFile],
  );

  const removeTab = useCallback(
    (id: string) => {
      setFiles((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setActiveTab((prev) => {
        if (prev !== id) return prev;
        // switch to the first remaining tab
        const remaining = [...files.keys()].filter((k) => k !== id);
        return remaining.length > 0 ? remaining[0]! : null;
      });
    },
    [files],
  );

  const tabLabel = (name: string) =>
    name.length > 40 ? name.slice(0, 18) + "..." + name.slice(-18) : name;

  const hasFiles = files.size > 0;

  return (
    <>
      <h4><a href="https://jsonl-tools.dev">jsonl-tools.dev</a></h4>
      <div
        className={`drop-zone${dragOver ? " drag-over" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <p>
          <strong>Drop JSONL files here</strong>
        </p>
        <p>or click to select files</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jsonl"
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
          }}
        />
      </div>

      {hasFiles && (
        <div className="tabs">
          {[...files.entries()].map(([id, { name }]) => (
            <button
              key={id}
              className={`tab${activeTab === id ? " active" : ""}`}
              onClick={() => setActiveTab(id)}
            >
              {tabLabel(name)}
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(id);
                }}
              >
                &times;
              </span>
            </button>
          ))}
        </div>
      )}

      {hasFiles ? (
        [...files.entries()].map(([id, { entries }]) => (
          <div
            key={id}
            className={`tab-content${activeTab === id ? " active" : ""}`}
          >
            <EntryTable entries={entries} />
          </div>
        ))
      ) : (
        <div className="empty-state">Drop JSONL files above to begin</div>
      )}

      <footer>
        &copy; 2026 jsonl-tools.dev |{" "}
        <a href="https://github.com/vire">created with 🤍 by vire</a>
      </footer>
    </>
  );
}

export default BulkAnalyzerApp;
