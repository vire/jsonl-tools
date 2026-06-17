// Recipient viewer (plan U4). Lives in its own analytics-free bundle (share.html
// → share-frontend.tsx). On a fresh link it reads the key from the URL fragment,
// strips it before any network request (R22), fetches ciphertext, decrypts
// client-side, and remembers the key on THIS device (on success) so the bare
// /s/<id> re-opens later without the link. On a return visit (no fragment) it
// recalls that saved key. Pure logic lives in share-viewer-core; key storage in
// share-remember.

import { useEffect, useMemo, useState } from "react";
import { EntryTable, parseJsonl } from "./entry-table";
import { DataView } from "./data-view";
import { SiteLogo } from "./site-logo";
import { assertCryptoAvailable } from "./share-crypto";
import {
  parseShareLocation,
  parseShareId,
  loadShare,
  loadRemembered,
  type ViewerState,
} from "./share-viewer-core";
import {
  rememberShareKey,
  recallShareKey,
  forgetShareKey,
} from "./share-remember";
import "./index.css";

const MESSAGES: Record<
  Exclude<ViewerState["status"], "ready" | "loading">,
  string
> = {
  "no-key":
    "This link is missing its decryption key. You need the full link, including the part after #.",
  unavailable:
    "This shared session is no longer available — it may have expired or been deleted.",
  retry: "Temporarily unavailable. Please try again in a moment.",
  "decrypt-failed":
    "Could not decrypt — the link may be wrong or the data tampered with.",
  insecure: "Secure context required: open this page over HTTPS.",
};

export function ShareViewer() {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [shareId, setShareId] = useState<string | null>(null);
  // Whether a key for this share is currently stored on THIS device. Set true
  // only after the write actually lands (fresh link) or a stored key is recalled
  // (return visit), so the "Saved on this device" label never overstates.
  const [saved, setSaved] = useState(false);
  // Recipient-chosen view. Table (the timestamp-sorted summary) is the default;
  // Data renders each line as a raw JSON tree. Local UI state only — not persisted.
  const [view, setView] = useState<"table" | "data">("table");

  // Parse once per decrypted payload, so flipping tabs doesn't re-parse. Empty
  // until the payload is ready.
  const plaintext = state.status === "ready" ? state.plaintext : "";
  const entries = useMemo(() => parseJsonl(plaintext), [plaintext]);

  useEffect(() => {
    try {
      assertCryptoAvailable();
    } catch {
      setState({ status: "insecure" });
      return;
    }
    const pathname = window.location.pathname;
    const loc = parseShareLocation(pathname, window.location.hash);
    // Strip the fragment BEFORE any network request (R22) so the key never lands
    // in a request or in history. Done on every path.
    window.history.replaceState(null, "", pathname);

    if (loc) {
      // Fresh link: decrypt, then remember the key on this device ONLY on success
      // (a wrong/tampered link must never persist a bad key). `saved` reflects the
      // actual write result.
      setShareId(loc.id);
      loadShare(loc).then(async (s) => {
        setState(s);
        if (s.status === "ready") {
          setSaved(await rememberShareKey(loc.id, loc.key));
        }
      });
      return;
    }

    // Return visit (no fragment): recall a key saved on this device, if any. A key
    // is present unless the recall missed (no-key) or it was purged as gone
    // (unavailable); a decrypt-failed key is still stored, so it stays forgettable.
    setShareId(parseShareId(pathname));
    loadRemembered(pathname, recallShareKey, forgetShareKey).then((s) => {
      setState(s);
      // `retry` keeps saved=true (the key is still in storage); no Forget UI is
      // rendered for that status, so it has no visible effect — keep that in mind
      // before wiring any future `retry`-state affordance.
      setSaved(s.status !== "no-key" && s.status !== "unavailable");
    });
  }, []);

  const forget = () => {
    if (shareId) void forgetShareKey(shareId);
    setSaved(false);
  };

  return (
    <div className="app">
      <header className="viewer-header">
        <h1 className="site-title">
          <a href="https://jsonl-tools.dev" aria-label="jsonl-tools">
            <SiteLogo />
          </a>
        </h1>
        <a className="viewer-back-link" href="https://jsonl-tools.dev">
          Analyze your own JSONL →
        </a>
      </header>
      <p className="viewer-tagline">
        End-to-end encrypted · decrypted in your browser
      </p>
      {state.status === "loading" && <p>Decrypting…</p>}
      {state.status === "ready" && (
        <div id="result">
          <div className="panel-tabs" role="tablist" aria-label="View mode">
            <button
              type="button"
              role="tab"
              aria-selected={view === "table"}
              className={view === "table" ? "panel-tab active" : "panel-tab"}
              onClick={() => setView("table")}
            >
              Table
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "data"}
              className={view === "data" ? "panel-tab active" : "panel-tab"}
              onClick={() => setView("data")}
            >
              Data
            </button>
          </div>
          {view === "table" ? (
            <EntryTable entries={entries} source={state.plaintext} />
          ) : (
            <DataView source={state.plaintext} showCopyAs />
          )}
        </div>
      )}
      {state.status !== "loading" && state.status !== "ready" && (
        <div className="validation-error">
          {MESSAGES[state.status]}
          {saved && state.status === "decrypt-failed" && (
            <div className="snapshot-actions">
              <button
                className="btn-snapshot"
                onClick={forget}
                title="Remove this device's saved key for this share"
              >
                Forget saved key
              </button>
            </div>
          )}
        </div>
      )}
      <footer>
        &copy; 2026 jsonl-tools.dev |{" "}
        <a href="https://github.com/vire">created with 🤍 by vire</a> |{" "}
        <a href="https://jsonl-tools.dev/#disclaimer">disclaimer</a>
      </footer>
    </div>
  );
}

export default ShareViewer;
