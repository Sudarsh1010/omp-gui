import type {
  OmpStartInfo,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
  BrowserInfo,
  BrowserError,
} from "../bindings/bindings.gen";

export type { OmpStartInfo, OmpFrameEvent, OmpExitEvent, BrowserInfo, BrowserError };

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
}

/**
 * A `ShellBridge` guaranteed to implement the Browser Pane methods — the
 * type `tauriBridge()` returns, since the real Tauri shell always supports
 * launching its own Chrome for Testing.
 */
export type BrowserShellBridge = ShellBridge &
  Required<Pick<ShellBridge, "browserLaunch" | "browserStop">>;

export class BridgeCommandError<E = BridgeError> extends Error {
  constructor(readonly error: E) {
    super(`bridge command failed: ${JSON.stringify(error)}`);
    this.name = "BridgeCommandError";
  }
}
