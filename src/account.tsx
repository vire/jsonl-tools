// Account + history panel (plan U7–U10 UI; sign-in-menu design 2026-06-04).
// Renders on the analytics-free home (R22). The top menu owns the logged-out CTA
// and sign-out; this panel only renders when signed in and drives passphrase
// setup/unlock, recovery, and My History, lifting the unlocked account up so
// logged-in shares can be saved to history.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  setupAccountFlow,
  unlockAccountFlow,
  verifyRecoveryCode,
  rotateAfterRecovery,
  fetchHistoryDecrypted,
  deleteHistoryEntry,
  saveToHistory,
  setHistoryShareState,
  renameHistoryEntry,
  mintCliTokenFlow,
  listCliTokens,
  revokeCliToken,
  type UnlockedAccount,
  type DecryptedHistoryItem,
  type CliTokenView,
} from "./account-client";
import { generatePassphrase } from "./passphrase-gen";
import { rememberAccount, recallAccount } from "./account-remember";
import { fetchWithSession } from "./session-id";

type Phase = "setup" | "unlock" | "recover" | "ready";

// A read-only value (generated passphrase, recovery code, or CLI command) sitting
// in a box with trailing icon buttons: `[ (prefix)value ] (actions…) (copy)`.
// `user-select: all` on the box makes one-click manual selection the fallback if
// the clipboard write is blocked, so a copy failure stays non-blocking. `prefix`
// (e.g. a `$` shell prompt) is shown but excluded from the copied text; `variant`
// swaps the box styling (secret vs. terminal command).
function CopyableSecret({
  value,
  actions,
  prefix,
  variant,
}: {
  value: string;
  actions?: ReactNode;
  prefix?: ReactNode;
  variant?: "command";
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* non-blocking: the value is visible and selectable in the box */
    }
  }
  return (
    <div className={variant === "command" ? "secret-row secret-row-command" : "secret-row"}>
      <div className="secret-box">
        {prefix}
        {value}
      </div>
      {actions}
      <button
        type="button"
        className="icon-button"
        onClick={copy}
        aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
        title={copied ? "Copied" : "Copy to clipboard"}
      >
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </div>
  );
}

// CLI token management (plan U5). Mint a per-box token (machine key generated
// client-side, wrapped under the account key), show the one-time credential, and
// list/revoke existing tokens. The mint form stays collapsed behind "+ Add" so
// the tab reads as a token list first.
function CliTokensTab({ accountKey }: { accountKey: CryptoKey }) {
  const [tokens, setTokens] = useState<CliTokenView[]>([]);
  const [label, setLabel] = useState("");
  const [credential, setCredential] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the (otherwise collapsed) mint form is open.
  const [adding, setAdding] = useState(false);

  async function refresh() {
    try {
      setTokens(await listCliTokens());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function mint() {
    setError(null);
    setBusy(true);
    try {
      const { credential: cred } = await mintCliTokenFlow(accountKey, label.trim() || "cli");
      setCredential(cred);
      setLabel("");
      setAdding(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancelAdd() {
    setAdding(false);
    setLabel("");
    setError(null);
  }

  async function revoke(tokenId: string) {
    setError(null);
    try {
      await revokeCliToken(tokenId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="cli-tokens">
      <p className="tab-hint">
        Create a token for a server box, then run the CLI there to paste it — it
        uploads JSONL files into your encrypted history.
      </p>
      <CopyableSecret
        value="npx @jsonl-tools/cli login"
        variant="command"
        prefix={<span className="cli-prompt">$</span>}
      />

      <div className="cli-tokens-header">
        <h3 className="cli-tokens-title">Tokens</h3>
        {!adding && (
          <button
            type="button"
            className="cli-add-button"
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add
          </button>
        )}
      </div>

      {adding && (
        <div className="input-row cli-add-form">
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            placeholder="Label (e.g. ci-runner)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void mint();
              if (e.key === "Escape") cancelAdd();
            }}
          />
          <button onClick={mint} disabled={busy}>
            {busy ? "Creating…" : "Create token"}
          </button>
          <button type="button" className="button-ghost" onClick={cancelAdd} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {credential && (
        <div className="recovery-code">
          <p>
            <strong>Copy this credential now</strong> — it is shown once. It
            carries a decryption key for this box; treat it like a password.
          </p>
          <CopyableSecret value={credential} />
          <button onClick={() => setCredential(null)}>Done</button>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="cli-tokens-empty">No CLI tokens yet.</p>
      ) : (
        <ul className="cli-token-list">
          {tokens.map((t) => (
            <li key={t.tokenId} className="cli-token-row">
              <div className="cli-token-info">
                <span className="cli-token-label">
                  {t.label ?? "(unlabeled)"}
                  {t.revoked && <span className="cli-token-tag">revoked</span>}
                </span>
                <span className="cli-token-meta">
                  {new Date(t.createdAt).toLocaleDateString()}
                  {t.lastUsedAt
                    ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                    : " · never used"}
                </span>
              </div>
              {!t.revoked && (
                <button className="cli-revoke-button" onClick={() => revoke(t.tokenId)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="validation-error">{error}</div>}
    </div>
  );
}

// The regenerate (↻) control that trails a generated passphrase, shared by the
// setup and recovery generators so both look and behave identically.
function RegenerateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-button"
      onClick={onClick}
      aria-label="Regenerate passphrase"
      title="Regenerate passphrase"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 3v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// One row in the History tab: title + meta, a share toggle (cyan on / grey off), a
// link-copy icon (active only when shared), and a ⋮ menu (Unshare / Rename / Delete).
// Self-contained interaction state; the parent owns the data + the async mutators.
function HistoryRow({
  item,
  onSetState,
  onRename,
  onDelete,
}: {
  item: DecryptedHistoryItem;
  onSetState: (state: "active" | "private") => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.title ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const shared = item.state === "active";
  const usable = (item.state === "active" || item.state === "private") && item.keyFragment != null;

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    if (!shared || !item.keyFragment) return;
    const link = `${window.location.origin}/s/${item.shareId}#key=${item.keyFragment}`;
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  if (item.state !== "active" && item.state !== "private") {
    // tombstoned (deleted/expired) entry still in the list until the sweeper cascade
    return (
      <div className="history-row">
        <div className="history-entry">
          <span>unavailable</span>
          <span className="history-meta">{item.shareId.slice(0, 10)} · {new Date(item.createdAt).toLocaleString()}</span>
        </div>
        <button type="button" className="history-remove" title="Remove from history" onClick={() => onDelete()}>×</button>
      </div>
    );
  }

  return (
    <div className="history-row">
      <div className="history-entry">
        {renaming ? (
          <input
            className="history-rename-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void withBusy(async () => { await onRename(draft); setRenaming(false); });
              if (e.key === "Escape") { setRenaming(false); setDraft(item.title ?? ""); }
            }}
            onBlur={() => { if (!busy) setRenaming(false); }}
          />
        ) : (
          <div className="history-title-row">
            {usable ? (
              <a href={`/s/${item.shareId}#key=${item.keyFragment}`}>{item.title ?? "(untitled)"}</a>
            ) : (
              <span>{item.title ?? "(untitled)"}</span>
            )}
          </div>
        )}
        <span className="history-meta">{item.shareId.slice(0, 10)} · {new Date(item.createdAt).toLocaleString()}</span>
      </div>

      {confirmDelete ? (
        <span className="history-confirm">
          Delete permanently?
          <button type="button" className="history-confirm-btn danger" disabled={busy}
            onClick={() => void withBusy(async () => { await onDelete(); })}>Confirm</button>
          <button type="button" className="history-confirm-btn" disabled={busy}
            onClick={() => setConfirmDelete(false)}>Cancel</button>
        </span>
      ) : (
        <div className="history-controls">
          <button
            type="button"
            role="switch"
            aria-checked={shared}
            aria-label={shared ? "Shared (encrypted)" : "Not shared"}
            title={shared ? "Shared — link is live" : "Private — toggle to share"}
            className={`share-toggle${shared ? " on" : ""}${busy ? " busy" : ""}`}
            disabled={busy}
            onClick={() => void withBusy(async () => { await onSetState(shared ? "private" : "active"); })}
          >
            <span className="share-toggle-track"><span className="share-toggle-knob" /></span>
          </button>

          <button
            type="button"
            className={`history-share${copied ? " copied" : ""}`}
            onClick={copyLink}
            disabled={!shared}
            title={shared ? (copied ? "Copied" : "Copy share link") : "Enable sharing to copy a link"}
            aria-label={shared ? "Copy share link" : "Sharing is off"}
          >
            {copied ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>

          <div className="row-menu-wrap" ref={menuRef}>
            <button type="button" className="row-menu-trigger" aria-haspopup="menu" aria-expanded={menuOpen}
              title="More" onClick={() => setMenuOpen((o) => !o)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
              </svg>
            </button>
            {menuOpen && (
              <div className="row-menu" role="menu">
                <button type="button" role="menuitem" className="row-menu-item" disabled={!shared}
                  onClick={() => { setMenuOpen(false); void withBusy(async () => { await onSetState("private"); }); }}>
                  Unshare
                </button>
                <button type="button" role="menuitem" className="row-menu-item" disabled={!usable}
                  onClick={() => { setMenuOpen(false); setDraft(item.title ?? ""); setRenaming(true); }}>
                  Rename
                </button>
                <div className="row-menu-sep" />
                <button type="button" role="menuitem" className="row-menu-item danger"
                  onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AccountPanel({
  signedIn,
  login,
  onAccount,
  currentSession = "",
}: {
  signedIn: boolean;
  login: string | null;
  onAccount?: (account: UnlockedAccount | null) => void;
  /** Current textarea content (owned by App) — what "Save current session" stores. */
  currentSession?: string;
}) {
  // `null` while the /api/account probe is in flight (nothing is rendered yet).
  const [phase, setPhase] = useState<Phase | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [shownRecovery, setShownRecovery] = useState<string | null>(null);
  const [history, setHistory] = useState<DecryptedHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Setup- and recovery-phase passphrase generation (shared `generated` state;
  // the two phases are mutually exclusive).
  const [generated, setGenerated] = useState("");
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  // Gates the recovery-code "Confirm" button (parallel to savedConfirmed for setup).
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);

  // Recover phase: the recovery code is verified against the account (read-only,
  // no server write) before the new-passphrase generator unlocks. `verifiedKey`
  // holds the unlocked account key so the rotation reuses it without re-fetching.
  const [verifiedKey, setVerifiedKey] = useState<CryptoKey | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Ready-phase tab: see shared pastes (history) or manage CLI tokens.
  // The unlocked account key is held to mint tokens.
  const [tab, setTab] = useState<"history" | "cli">("history");
  const [accountKey, setAccountKey] = useState<CryptoKey | null>(null);

  useEffect(() => {
    // Signed out (or signing out): reset everything so a later sign-in is clean.
    // App owns the account state and already cleared it via onAccount(null).
    if (!signedIn) {
      setPhase(null);
      setPassphrase("");
      setRecoveryCode("");
      setShownRecovery(null);
      setHistory([]);
      setError(null);
      setGenerated("");
      setSavedConfirmed(false);
      setAccountKey(null);
      setVerifiedKey(null);
      setVerifying(false);
      setVerifyError(null);
      return;
    }

    // Identity is known. If this device remembers the key for the signed-in user,
    // auto-unlock and skip the passphrase. Otherwise probe key-custody: 404 (no
    // account → setup) or 200 (account exists → unlock).
    let cancelled = false;
    (async () => {
      if (login) {
        const recalled = await recallAccount(login);
        if (recalled && !cancelled) {
          await afterUnlock({ accountKey: recalled, authTag: "" }, false);
          return;
        }
      }
      try {
        const r = await fetchWithSession("/api/account", undefined, "home");
        if (cancelled) return;
        if (r.status === 404) {
          setSavedConfirmed(false);
          regenerate();
          setPhase("setup");
        } else if (r.ok) {
          setPhase("unlock");
        } else {
          setError("Could not load your account — please sign in again.");
        }
      } catch {
        if (!cancelled) setError("Could not reach the server — check your connection.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, login]);

  // `store` is false only on the auto-unlock (recall) path, which already came
  // from storage. doSetup/doUnlock/doRecover use the default (store = true).
  async function afterUnlock(account: UnlockedAccount, store = true) {
    if (store && login) void rememberAccount(login, account.accountKey);
    setAccountKey(account.accountKey);
    onAccount?.(account);
    try {
      setHistory(await fetchHistoryDecrypted(account.accountKey));
    } catch {
      /* history is best-effort */
    }
    setPhase("ready");
  }

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reloadHistory() {
    if (!accountKey) return;
    try {
      setHistory(await fetchHistoryDecrypted(accountKey));
    } catch {
      /* best-effort */
    }
  }

  const saveCurrent = () =>
    run(async () => {
      if (!accountKey || !currentSession.trim()) return;
      await saveToHistory(currentSession, accountKey, {});
      await reloadHistory();
    });

  const setRowState = (h: DecryptedHistoryItem, state: "active" | "private") =>
    run(async () => {
      await setHistoryShareState(h.shareId, state);
      setHistory((prev) => prev.map((x) => (x.shareId === h.shareId ? { ...x, state } : x)));
    });

  const renameRow = (h: DecryptedHistoryItem, title: string) =>
    run(async () => {
      if (!h.keyFragment) return;
      const next = title.trim() || "(untitled)";
      await renameHistoryEntry(h.shareId, h.keyFragment, next);
      setHistory((prev) => prev.map((x) => (x.shareId === h.shareId ? { ...x, title: next } : x)));
    });

  const deleteRow = (h: DecryptedHistoryItem) =>
    run(async () => {
      await deleteHistoryEntry(h.shareId);
      setHistory((prev) => prev.filter((x) => x.shareId !== h.shareId));
    });

  // Never weaken entropy silently: if crypto is unavailable, surface the error
  // rather than falling back to a weak source.
  function regenerate() {
    try {
      setGenerated(generatePassphrase());
      setSavedConfirmed(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Editing the recovery code invalidates any prior verification: the unlocked
  // key (and the generated passphrase it gated) belonged to the old code.
  function onRecoveryCodeChange(value: string) {
    setRecoveryCode(value);
    if (verifiedKey) setVerifiedKey(null);
    if (verifyError) setVerifyError(null);
  }

  // Read-only check of the recovery code (no server write); on success it unlocks
  // the new-passphrase generator. Runs on blur / Enter, skipping empty input and
  // codes already verified.
  async function verifyRecovery() {
    const code = recoveryCode.trim();
    if (!code || verifying || verifiedKey) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const key = await verifyRecoveryCode(code);
      setVerifiedKey(key);
      regenerate(); // populate the first new passphrase now that the code is accepted
    } catch {
      setVerifiedKey(null);
      setVerifyError("That recovery code isn't valid. Check it and try again.");
    } finally {
      setVerifying(false);
    }
  }

  const doSetup = () =>
    run(async () => {
      const { recoveryCode: code, account } = await setupAccountFlow(generated);
      setRecoveryConfirmed(false);
      setShownRecovery(code);
      await afterUnlock(account);
    });
  const doUnlock = () =>
    run(async () => afterUnlock(await unlockAccountFlow(passphrase)));
  const doRecover = () =>
    run(async () => {
      if (!verifiedKey) throw new Error("Verify your recovery code first.");
      const { recoveryCode: code, account } = await rotateAfterRecovery(
        recoveryCode.trim(),
        verifiedKey,
        generated,
      );
      setRecoveryConfirmed(false);
      setShownRecovery(code);
      await afterUnlock(account);
    });

  if (!signedIn) return null;

  return (
    <div className="account-panel">

      {phase === "setup" && (
        <div>
          <p>
            We generated a strong passphrase for your encrypted history. Save it
            in your password manager — we cannot reset it.
          </p>
          <CopyableSecret value={generated} actions={<RegenerateButton onClick={regenerate} />} />
          <label className="saved-confirm">
            <input
              type="checkbox"
              checked={savedConfirmed}
              onChange={(e) => setSavedConfirmed(e.target.checked)}
            />
            I&apos;ve saved this to my password manager
          </label>
          <button onClick={doSetup} disabled={busy || !savedConfirmed}>
            {busy ? "Securing…" : "Secure my data"}
          </button>
        </div>
      )}

      {phase === "unlock" && (
        <div className="input-row">
          <input
            type="text"
            placeholder="Paste your passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button onClick={doUnlock} disabled={busy}>
            {busy ? "Unlocking…" : "Unlock history"}
          </button>
          <button className="button-ghost" onClick={() => setPhase("recover")}>
            Lost passphrase?
          </button>
        </div>
      )}

      {phase === "recover" && (
        <div className="recover-flow">
          <p>Enter your recovery code, then generate a new passphrase.</p>

          {/* 1. Recovery code — verified against your account before the rest unlocks. */}
          <div className="recover-step">
            <input
              className="recovery-code-input"
              placeholder="Recovery code"
              value={recoveryCode}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={verifyError ? true : undefined}
              onChange={(e) => onRecoveryCodeChange(e.target.value)}
              onBlur={verifyRecovery}
              onKeyDown={(e) => {
                if (e.key === "Enter") verifyRecovery();
              }}
            />
            {verifying ? (
              <span className="recover-status">Checking…</span>
            ) : verifiedKey ? (
              <span className="recover-status ok">Recovery code accepted</span>
            ) : verifyError ? (
              <span className="recover-status error">{verifyError}</span>
            ) : null}
          </div>

          {/* 2. New passphrase — same generator as setup, active once the code is accepted. */}
          {verifiedKey ? (
            <CopyableSecret
              value={generated}
              actions={<RegenerateButton onClick={regenerate} />}
            />
          ) : (
            <div className="secret-row is-disabled" aria-disabled="true">
              <div className="secret-box placeholder">
                New passphrase — verify your recovery code first
              </div>
              <button type="button" className="icon-button" disabled aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M21 3v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          )}

          {/* 3. Recover. */}
          <button onClick={doRecover} disabled={busy || !verifiedKey || !generated}>
            {busy ? "Recovering…" : "Recover"}
          </button>
        </div>
      )}

      {phase === "ready" && (
        <div>
          {shownRecovery ? (
            <div className="recovery-code">
              <p>
                <strong>Save your recovery code</strong> — it is shown once and is
                the only way back if you forget your passphrase:
              </p>
              <CopyableSecret value={shownRecovery} />
              <label className="saved-confirm">
                <input
                  type="checkbox"
                  checked={recoveryConfirmed}
                  onChange={(e) => setRecoveryConfirmed(e.target.checked)}
                />
                I&apos;ve saved my recovery code
              </label>
              <button
                onClick={() => setShownRecovery(null)}
                disabled={!recoveryConfirmed}
              >
                Confirm
              </button>
            </div>
          ) : (
          <>
          <div className="panel-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "history"}
              className={tab === "history" ? "panel-tab active" : "panel-tab"}
              onClick={() => setTab("history")}>History</button>
            <button type="button" role="tab" aria-selected={tab === "cli"}
              className={tab === "cli" ? "panel-tab active" : "panel-tab"}
              onClick={() => setTab("cli")}>CLI</button>
          </div>
          {tab === "cli" ? (
            accountKey && <CliTokensTab accountKey={accountKey} />
          ) : (
            <div className="history-pane">
              <div className="history-pane-header">
                <button
                  type="button"
                  className="cli-add-button"
                  disabled={busy || !currentSession.trim()}
                  title={currentSession.trim() ? "Save the current session to your history" : "Paste or upload a session below first"}
                  onClick={saveCurrent}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Save current session
                </button>
              </div>
              {history.length === 0 ? (
                <p>No saved sessions yet. Save one above, then toggle Share to get a link.</p>
              ) : (
                <ul className="history-list">
                  {history.map((h) => (
                    <li key={h.shareId}>
                      <HistoryRow
                        item={h}
                        onSetState={(state) => setRowState(h, state)}
                        onRename={(title) => renameRow(h, title)}
                        onDelete={() => deleteRow(h)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          </>
          )}
        </div>
      )}
      {error && <div className="validation-error">{error}</div>}
    </div>
  );
}
