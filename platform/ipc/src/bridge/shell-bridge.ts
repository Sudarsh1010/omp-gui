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
  ChromiumInstallEvent,
  AppPreferences,
  PreferencesError,
  EffectivePreferences,
  PathProbe,
  OmpBinaryInfo,
  OmpBinarySource,
  OmpOverrideError,
  SmokeReport,
  SmokeFailure,
  SmokeStage,
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
  ChromiumInstallEvent,
  AppPreferences,
  PreferencesError,
  EffectivePreferences,
  PathProbe,
  OmpBinaryInfo,
  OmpBinarySource,
  OmpOverrideError,
  SmokeReport,
  SmokeFailure,
  SmokeStage,
};

export interface ShellBridge {
  /** Spawn a subprocess and return its identity metadata. `cwd` sets the
   * subprocess working directory; callers resuming a session pass that
   * session's recorded cwd so omp's `switch_session` guard (no cwd-change
   * opt-in over rpc-ui) accepts the resume. Defaults to a bridge-chosen
   * directory when omitted. */
  start(cwd?: string): Promise<OmpStartInfo>;
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
  /**
   * Download a headed Chrome for Testing (Stable) into the cache
   * `browserLaunch` scans, resolving with the installed executable path.
   * ADR-0006 requires a headed binary — omp's own browser tool only ever
   * downloads the headless-only `chrome-headless-shell` — so acquisition
   * is the shell's job. Progress streams via `onChromiumInstallProgress`.
   */
  browserInstallChromium?(): Promise<string>;
  /** Subscribe to `browserInstallChromium` progress events. */
  onChromiumInstallProgress?(handler: (e: ChromiumInstallEvent) => void): () => void;
  /**
   * Read the app-owned App Preferences file (theme, omp/Chromium path
   * overrides, default working directory) — always available, even when
   * omp itself is unreachable (ADR-0011). Optional: `nodeBridge` only
   * implements it when constructed with a `preferencesPath` option, since
   * most seam tests don't exercise App Preferences at all.
   */
  preferencesRead?(): Promise<AppPreferences>;
  /**
   * Write the App Preferences file, preserving any keys this app version
   * doesn't know about, and return what is now on disk. Optional for the
   * same reason as `preferencesRead`.
   */
  preferencesWrite?(prefs: AppPreferences): Promise<AppPreferences>;
  /**
   * The default working directory a fresh session would actually spawn
   * into and the Chromium executable the Browser Pane would actually
   * launch, plus where each came from (#22, issue #19: "Both rows show
   * the effective value and where it came from"). Optional for the same
   * reason as `preferencesRead`.
   */
  preferencesEffective?(): Promise<EffectivePreferences>;
  /**
   * Probe an arbitrary filesystem path (existence, directory-ness,
   * executable-ness) so the working-directory/Chromium-path rows (#22)
   * can validate an edit inline before committing it — the validated
   * path field stands in for a directory picker since no Tauri dialog
   * plugin is wired in yet. Optional for the same reason as
   * `preferencesRead`.
   */
  pathProbe?(path: string): Promise<PathProbe>;
  /**
   * Reports which omp binary the app currently resolves to run (ADR-0004:
   * resolved path, version, and whether that's the bundled pin, a
   * committed App Preferences override, or the `OMP_GUI_OMP_PATH` env
   * override). Never rejects — even a broken committed override must
   * leave this row usable (ADR-0011's "bootstrap independence"). Optional:
   * only the Tauri shell replicates the full env -> preference ->
   * dev/bundled resolution chain from `omp::resolve_omp_path`.
   */
  ompBinaryInfo?(): Promise<OmpBinaryInfo>;
  /**
   * Runs the shared launch-time protocol smoke test
   * (`crates/shell/src/smoke.rs`) against an arbitrary candidate path
   * without committing anything — spawn, await the `ready` frame, one
   * canned round trip, kill. Rejects with `BridgeCommandError<SmokeFailure>`
   * naming the failed stage. `nodeBridge` implements this one
   * unconditionally (it needs no preferences file) so the ipc seam test
   * can prove a fake executable fails at a named stage without the Tauri
   * shell.
   */
  ompSmokeTest?(path: string): Promise<SmokeReport>;
  /**
   * Smoke-tests `path` and, only on success, commits it as the App
   * Preferences omp override (ADR-0004's compatibility-risk gate — the
   * acknowledgement dialog itself is a GUI-only concern, wired in
   * `omp-binary-row.tsx`). A failed smoke test writes nothing; the
   * previous override is retained. Optional for the same reason as
   * `ompBinaryInfo`.
   */
  ompOverrideCommit?(path: string): Promise<OmpBinaryInfo>;
  /**
   * Reverts the App Preferences omp override to the bundled pin — no
   * smoke test needed. Optional for the same reason as `ompBinaryInfo`.
   */
  ompOverrideClear?(): Promise<OmpBinaryInfo>;
}

/**
 * A `ShellBridge` guaranteed to implement the Browser Pane methods — the
 * type `tauriBridge()` returns, since the real Tauri shell always supports
 * launching its own Chrome for Testing.
 */
export type BrowserShellBridge = ShellBridge &
  Required<
    Pick<
      ShellBridge,
      | "browserLaunch"
      | "browserStop"
      | "browserSetRelay"
      | "browserSetTakeover"
      | "browserInstallChromium"
      | "onChromiumInstallProgress"
    >
  >;

export class BridgeCommandError<E = BridgeError> extends Error {
  constructor(readonly error: E) {
    super(`bridge command failed: ${JSON.stringify(error)}`);
    this.name = "BridgeCommandError";
  }
}
