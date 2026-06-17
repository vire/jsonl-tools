import { useState, useEffect, useRef } from "react";
import "./index.css";
import { EntryTable, parseJsonl as parseJsonlEntries, type ParsedEntry } from "./entry-table";
import { DataView } from "./data-view";
import { SiteLogo } from "./site-logo";
import jsonlExample from "./jsonl-example.jsonl" with { type: "text" };
import { createShare, revokeShare } from "./api-client";
import { fetchWithSession } from "./session-id";
import { rememberShare, forgetShare } from "./local-store";
import { AccountPanel } from "./account";
import { type UnlockedAccount } from "./account-client";
import { forgetAccount, isRemembered } from "./account-remember";

type Feature = "format" | "convert-to-json" | "upload";

function isEnabledFeature(feature: Feature): boolean {
  return false;
}

function validateJsonl(content: string): string | null {
  if (!content.trim()) {
    return null;
  }

  const lines = content.split("\n");
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    try {
      JSON.parse(line);
    } catch (err) {
      const message = (err as Error).message;
      errors.push(`Line ${i + 1}: ${message}`);
      if (errors.length >= 5) {
        errors.push("... and more errors");
        break;
      }
    }
  }

  return errors.length > 0 ? errors.join("\n") : null;
}

type ViewMode = "none" | "viewer" | "durations";

// Identity state owned by App (via /api/auth/me). `null` = logged out; an object
// with `login: null` = logged in but a pre-migration row (login not yet captured).
// `undefined` = still loading (render nothing in the menu slot to avoid flashing
// "Sign In" at a logged-in user).
type Me = { login: string | null } | null;

export function App() {
  const [content, setContent] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("none");
  const [durationsData, setDurationsData] = useState<ParsedEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showJsonlModal, setShowJsonlModal] = useState(false);
  const [showDisclaimerModal, setShowDisclaimerModal] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  // The live share's id + admin token, kept in memory so the toggle can revoke
  // it. Non-null exactly when there is a resolvable share (toggle is "on").
  const [liveShare, setLiveShare] = useState<{ id: string; adminToken: string } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [account, setAccount] = useState<UnlockedAccount | null>(null);
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [remembered, setRemembered] = useState(false);

  useEffect(() => {
    if (window.location.hash === "#what-is-jsonl") {
      setShowJsonlModal(true);
    } else if (window.location.hash === "#disclaimer") {
      setShowDisclaimerModal(true);
    }
  }, []);

  // Identity is independent of account-key custody: /api/auth/me answers "who is
  // signed in" and works before any account is set up. A network failure is
  // treated as logged-out — the menu shows "Sign In" and the user can retry.
  useEffect(() => {
    // This on-load call doubles as the home page-view signal: the "home" surface
    // label tells the server to record a page-view (KTD2). No new request added.
    fetchWithSession("/api/auth/me", undefined, "home")
      .then((r) => (r.ok ? (r.json() as Promise<{ login: string | null }>) : null))
      .then((data) => setMe(data))
      .catch(() => setMe(null));
  }, []);

  // Reflect whether this device currently remembers the signed-in user's key.
  // Optimistically true once unlocked (afterUnlock stores it best-effort).
  useEffect(() => {
    if (account && me?.login) {
      setRemembered(true);
      return;
    }
    if (me?.login) {
      isRemembered(me.login).then(setRemembered);
      return;
    }
    setRemembered(false);
  }, [account, me]);

  const handleSignOut = async () => {
    if (me?.login) await forgetAccount(me.login);
    try {
      await fetchWithSession("/api/auth/logout", { method: "POST" }, "home");
    } finally {
      setMe(null);
      setAccount(null);
      setRemembered(false);
    }
  };

  // Forget only THIS device's stored key; the current in-memory session stays
  // unlocked until reload/sign-out. Next visit will ask for the passphrase again.
  const handleForgetDevice = async () => {
    if (me?.login) await forgetAccount(me.login);
    setRemembered(false);
  };

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    setValidationError(validateJsonl(newContent));
  };

  const handleAnalyzeDurations = () => {
    setError(null);
    setViewMode("durations");

    try {
      const parsed = parseJsonlEntries(content);
      if (parsed.length === 0) {
        setError("No data to display");
        return;
      }
      setDurationsData(parsed);
    } catch (err) {
      setError("Error: " + (err as Error).message);
    }
  };

  const handleViewer = () => {
    setError(null);
    setViewMode("viewer");
    if (!content.trim()) setError("No data to display");
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const maxSize = 50 * 1024 * 1024; // 50MB
      if (file.size > maxSize) {
        setError("File size exceeds 50MB limit");
        return;
      }
      setError(null);
      file.text().then((text) => handleContentChange(text));
    }
  };

  // Toggle ON: mint a fresh share (encrypt + upload) and show its live link.
  const handleShare = async () => {
    setError(null);
    setShareLink(null);
    if (!content.trim()) {
      setError("Nothing to share — paste or upload a session first.");
      return;
    }
    setSharing(true);
    try {
      const out = await createShare(content);
      await rememberShare({
        id: out.id,
        link: out.link,
        adminToken: out.adminToken,
        contentKey: out.contentKey,
        createdAt: Date.now(),
      });
      setShareLink(out.link);
      setLiveShare({ id: out.id, adminToken: out.adminToken });
    } catch (err) {
      setError("Share failed: " + (err as Error).message);
    } finally {
      setSharing(false);
    }
  };

  // Toggle OFF: revoke the live share server-side so its link stops resolving.
  // Destructive by design — re-enabling mints a brand-new share and link.
  const handleUnshare = async () => {
    if (!liveShare) return;
    setError(null);
    setSharing(true);
    try {
      await revokeShare(liveShare.id, liveShare.adminToken);
      await forgetShare(liveShare.id); // drop the now-dead share from this device
      setShareLink(null);
      setLiveShare(null);
    } catch (err) {
      setError("Couldn't un-share: " + (err as Error).message);
    } finally {
      setSharing(false);
    }
  };

  const toggleShare = () => (liveShare ? handleUnshare() : handleShare());

  const handleCopyShareLink = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const handleCopyAsJson = async () => {
    try {
      const lines = content.trim().split("\n").filter(Boolean);
      const jsonArray = lines.map((line) => JSON.parse(line));
      const formatted = JSON.stringify(jsonArray, null, 2);
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError("Error: " + (err as Error).message);
    }
  };

  const hasContent = content.trim().length > 0;
  // Built once; rendered only when logged out (below the menu, above the paste box).
  // It reads App's share state directly.
  const shareCard = (
    <div className="share-card">
      <div className="share-toggle-row">
        <button
          type="button"
          role="switch"
          aria-checked={shareLink !== null}
          aria-label="Share (encrypted)"
          className={`share-toggle${shareLink !== null ? " on" : ""}${sharing ? " busy" : ""}`}
          onClick={toggleShare}
          disabled={sharing || (shareLink === null && !hasContent)}
        >
          <span className="share-toggle-track">
            <span className="share-toggle-knob" />
          </span>
        </button>
        <span className="share-toggle-label">
          {sharing
            ? shareLink !== null
              ? "Revoking…"
              : "Encrypting…"
            : shareLink !== null
              ? "Shared"
              : "Share (encrypted)"}
        </span>
      </div>
      {shareLink && (
        <div className="share-result">
          <p>
            <strong>Encrypted share link.</strong> The decryption key is in the{" "}
            <code>#</code> fragment and was never sent to the server — anyone with
            the full link can read this session in their browser.
          </p>
          <div className="share-link-row">
            <input
              readOnly
              value={shareLink}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button onClick={handleCopyShareLink}>
              {shareCopied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <h1 className="site-title">
        <a href="https://jsonl-tools.dev" aria-label="jsonl-tools">
          <SiteLogo />
        </a>
      </h1>
      <div className="info-links">
        <a
          href="#what-is-jsonl"
          className="what-is-jsonl-link"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = "what-is-jsonl";
            setShowJsonlModal(true);
          }}
        >
          What is JSONL?
        </a>
        <span className="link-separator">|</span>
        <a
          href="#"
          className="load-example-link"
          onClick={(e) => {
            e.preventDefault();
            handleContentChange(jsonlExample);
          }}
        >
          Load Example JSONL
        </a>
        <span className="link-separator">|</span>
        <a href="/docs" className="load-example-link">
          Docs
        </a>
        {me !== undefined && (
          <>
            <span className="link-separator">|</span>
            {me === null ? (
              <a href="/api/auth/login" className="load-example-link">
                Sign In
              </a>
            ) : (
              <UserMenu
                    login={me.login}
                    remembered={remembered}
                    onForgetDevice={handleForgetDevice}
                    onSignOut={handleSignOut}
                  />
            )}
          </>
        )}
      </div>
      <AccountPanel
        signedIn={!!me}
        login={me?.login ?? null}
        onAccount={setAccount}
        currentSession={content}
      />
      {/* Logged out / pre-unlock the account panel renders nothing, so the share
          box lands in that slot — just under the menu, above the paste box. */}
      {!account && shareCard}
      <textarea
        id="content"
        placeholder="Paste JSONL content here..."
        value={content}
        onChange={(e) => handleContentChange(e.target.value)}
      />
      <div className="button-group">
        <label className="button-ghost">
          Upload
          <input type="file" onChange={handleUpload} />
        </label>
        <div className="button-group-right">
          {isEnabledFeature("format") && (
            <button disabled title="Coming soon">
              Format
            </button>
          )}
          {isEnabledFeature("convert-to-json") && (
            <button disabled title="Coming soon">
              Convert to JSON
            </button>
          )}
          <button onClick={handleCopyAsJson}>
            {copied ? "JSON in clipboard" : "Copy as JSON"}
          </button>
          <button onClick={handleViewer}>View</button>
          <button onClick={handleAnalyzeDurations}>Analyze Durations</button>
        </div>
      </div>

      {validationError && (
        <div className="validation-error">
          <strong>Invalid JSONL:</strong>
          <pre>{validationError}</pre>
        </div>
      )}

      {error && (
        <div id="result">
          <div className="error">{error}</div>
        </div>
      )}

      {!error && viewMode === "durations" && durationsData.length > 0 && (
        <div id="result">
          <EntryTable entries={durationsData} source={content} />
        </div>
      )}

      {!error && viewMode === "viewer" && content.trim() && (
        <div id="result">
          <DataView source={content} />
        </div>
      )}
      {showJsonlModal && (
        <JsonlModal
          onClose={() => {
            setShowJsonlModal(false);
            if (window.location.hash === "#what-is-jsonl") {
              history.replaceState(null, "", window.location.pathname);
            }
          }}
        />
      )}
      {showDisclaimerModal && (
        <DisclaimerModal
          onClose={() => {
            setShowDisclaimerModal(false);
            if (window.location.hash === "#disclaimer") {
              history.replaceState(null, "", window.location.pathname);
            }
          }}
        />
      )}
      <footer>
        &copy; 2026 jsonl-tools.dev |{" "}
        <a href="https://github.com/vire">created with 🤍 by vire</a> |{" "}
        <a
          href="#disclaimer"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = "disclaimer";
            setShowDisclaimerModal(true);
          }}
        >
          disclaimer
        </a>
      </footer>
    </div>
  );
}

// Username dropdown in the top menu. Holds Logout today; structured so future
// items (Settings, etc.) drop in without restructuring. `login` may be null for a
// pre-migration row — fall back to a neutral label rather than rendering "@null".
function UserMenu({
  login,
  remembered,
  onForgetDevice,
  onSignOut,
}: {
  login: string | null;
  remembered: boolean;
  onForgetDevice: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {login ? `@${login}` : "Account"} ▾
      </button>
      {open && (
        <div className="user-menu-popover" role="menu">
          {/* "Forget this device" hidden for now (2026-06-04). Handler + wiring
              left intact (onForgetDevice / remembered) so it can be restored. */}
          {false && remembered && (
            <button
              type="button"
              role="menuitem"
              className="user-menu-item"
              onClick={() => {
                setOpen(false);
                onForgetDevice();
              }}
            >
              Forget this device
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="user-menu-item"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}

function JsonlModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          &times;
        </button>
        <h2>What is JSONL?</h2>
        <p>
          <strong>JSONL</strong> (JSON Lines) is a text format where each line
          is a valid JSON object. Unlike standard JSON arrays, JSONL doesn't
          require wrapping objects in brackets or separating them with commas.
        </p>

        <h3>Why is it useful?</h3>
        <ul>
          <li>
            <strong>Streaming:</strong> Process data line by line without
            loading the entire file into memory
          </li>
          <li>
            <strong>Append-friendly:</strong> Add new records by simply
            appending lines to a file
          </li>
          <li>
            <strong>Error resilience:</strong> A malformed line doesn't break
            the entire file
          </li>
          <li>
            <strong>Simple parsing:</strong> Read one line, parse one JSON
            object
          </li>
        </ul>

        <h3>Example</h3>
        <pre>
          {`{"name": "Alice", "age": 30}
{"name": "Bob", "age": 25}
{"name": "Charlie", "age": 35}`}
        </pre>

        <h3>Common Use Cases</h3>
        <ul>
          <li>Log files and application event streams</li>
          <li>Data export/import for large datasets</li>
          <li>Machine learning training data</li>
          <li>Database dumps and migrations</li>
          <li>API response streaming</li>
          <li>Analytics and metrics collection</li>
          <li>
            <strong>Anthropic / Claude Code:</strong> Claude Code stores
            conversation history and project data in JSONL format in{" "}
            <code>~/.claude/projects/</code>
          </li>
        </ul>
      </div>
    </div>
  );
}

function DisclaimerModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          &times;
        </button>
        <h2>Disclaimer</h2>
        <ul>
          <li>
            <strong>Browser-only analysis:</strong> Pasting, viewing, and
            analyzing happen entirely in your browser — that data is never sent
            to any server.
          </li>
          <li>
            <strong>Encrypted sharing:</strong> When you create a share link,
            your session is encrypted in your browser first. We upload only data
            we cannot read — the server stores ciphertext, and the decryption key
            stays in the link's <code>#</code> fragment, which is never sent to
            the server. Treat the link as a secret; anyone with it can read the
            session.
          </li>
          <li>
            <strong>Saved history:</strong> when signed in, sessions you explicitly{" "}
            <em>Save to History</em> are encrypted in your browser and stored as
            ciphertext we cannot read — the same zero-knowledge model as sharing. A
            saved entry stays <strong>private</strong> until you toggle Share on.
          </li>
          <li>
            <strong>No third-party tracking</strong> runs on this page. We keep
            first-party usage counts (which pages and features get used) to guide
            development. These counts include no file contents, no decryption
            keys, no IP address, and no account identity, and are never linked
            across sessions.
          </li>
          <li>
            <strong>Limits:</strong> Because the page is served to your browser,
            a compromised server could in principle serve tampered code. This
            tool is provided as-is, without warranties of any kind.
          </li>
        </ul>
      </div>
    </div>
  );
}

export default App;
