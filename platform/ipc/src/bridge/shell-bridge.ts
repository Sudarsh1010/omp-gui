import type {
  OmpStartInfo,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
} from "../bindings/bindings.gen";

export type { OmpStartInfo, OmpFrameEvent, OmpExitEvent };

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
}

export class BridgeCommandError extends Error {
  constructor(readonly error: BridgeError) {
    super(`bridge command failed: ${JSON.stringify(error)}`);
    this.name = "BridgeCommandError";
  }
}
