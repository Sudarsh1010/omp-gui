import type {
  OmpStartInfo,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
  BrowserInfo,
  BrowserError,
  RelayInfo,
  SessionFileEntry,
  SessionsError,
  ForeignLockProbe,
  SessionPreview,
} from "../bindings/bindings.gen";

export type {
  OmpStartInfo,
  OmpFrameEvent,
  OmpExitEvent,
  BrowserInfo,
  BrowserError,
  RelayInfo,
  SessionFileEntry,
  SessionsError,
  ForeignLockProbe,
  SessionPreview,
};

export interface ShellBridge {
  /** Spawn a subprocess and return its identity metadata. */
  start(): Promise<OmpStartInfo>;
  /** Write one NDJSON command line to the given session's stdin. */
  send(sessionId: string, line: string): Promise<void>;
  /** Kill the subprocess for the given session. */
  kill(sessionId: string): Promise<void>;
  /** Subscribe to NDJSON stdout frames keyed by sessionId. */
  onFrame(handler: (e: OmpFrameEvent) => void): () => void;
  /** Subscribe to subprocess exit events keyed by sessionId. */
  onExit(handler: (e: OmpExitEvent) => void): () => void;
  /**
   * Launch (or, if already running for this project, attach to) the
   * app-owned Browser Pane Chromium (ADR-0006). Optional: only the real
   * Tauri shell owns a Chrome-for-Testing process to launch — bridges built
   * for the omp session seam alone (e.g. `nodeBridge`) do not implement it.
   */
  browserLaunch?(projectPath: string): Promise<BrowserInfo>;
  /** Release this caller's interest in the project's Browser Pane. */
  browserStop?(projectPath: string): Promise<void>;
  /**
   * Toggle a session's browser between the app-owned connected Chromium
   * (T9, ADR-0006) and omp's `relay` kind, which drives the user's own,
   * already-logged-in Chrome through the browser-relay extension
   * (ADR-0006 §"Human-in-the-loop", issue #12). Optional for the same
   * reason `browserLaunch`/`browserStop` are.
   */
  browserSetRelay?(sessionId: string, enabled: boolean): Promise<RelayInfo>;
  /**
   * Toggle Takeover for a project's Browser Pane: while enabled, pane
   * mouse/keyboard input is dispatched into the live Chromium; while
   * disabled, agent-driven browser use resumes (see
   * `crates/shell/src/browser.rs`'s `browser_set_takeover` and
   * `BrowserPane.tsx`'s `denyBrowserApprovalsWhileTakenOver`). Optional for
   * the same reason as `browserLaunch`/`browserStop`.
   */
  browserSetTakeover?(projectPath: string, enabled: boolean): Promise<void>;
  /**
   * Enumerate every on-disk session file across all projects, newest-first,
   * without spawning omp (T7, issue #8). Optional: only the real Tauri
   * shell can walk the filesystem directly from a webview; `nodeBridge`
   * implements it too (against the same on-disk layout, via the pinned
   * package's own `listAllSessions`) since the seam tests drive this
   * without Tauri at all — a bridge with neither has no session directory
   * feature to offer.
   */
  listSessionFiles?(): Promise<SessionFileEntry[]>;
  /**
   * Best-effort scan for an OS process — other than one this app itself
   * spawned — holding `path` open (ADR-0005's single-writer guard).
   * Tauri-only: asking the OS which process has a file open is not
   * something `nodeBridge`'s seam tests need — they exercise the
   * deterministic half of the guard (`session-directory.ts`'s own
   * in-memory ownership registry) against two real, app-driven
   * subprocesses instead.
   */
  probeForeignSessionLock?(path: string): Promise<ForeignLockProbe>;
  /**
   * Read-only bounded reconstruction of a session's early messages, for
   * the switcher's "view read-only" affordance on a guarded file. Optional
   * for the same reason as `listSessionFiles`.
   */
  readSessionPreview?(path: string): Promise<SessionPreview>;
}

/**
 * A `ShellBridge` guaranteed to implement the Browser Pane methods — the
 * type `tauriBridge()` returns, since the real Tauri shell always supports
 * launching its own Chrome for Testing.
 */
export type BrowserShellBridge = ShellBridge &
  Required<
    Pick<ShellBridge, "browserLaunch" | "browserStop" | "browserSetRelay" | "browserSetTakeover">
  >;

export class BridgeCommandError<E = BridgeError> extends Error {
  constructor(readonly error: E) {
    super(`bridge command failed: ${JSON.stringify(error)}`);
    this.name = "BridgeCommandError";
  }
}
