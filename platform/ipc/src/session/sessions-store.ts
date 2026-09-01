/**
 * Multi-session dispatcher core (T8, issue #9; ADR-0005 "N sessions = N
 * subprocesses, no cap"). Owns N concurrent `IpcSessionHandle`s, each paired
 * with the `Transcript` that normalizes its event stream, keyed by a
 * store-local session id. Framework-agnostic like `Transcript` itself (no
 * React import here) — `subscribe`/pull-accessor is an external-store shape
 * compatible with React's `useSyncExternalStore`, so `gui/src/session/
 * use-sessions.ts` is a thin bridge, not where this state actually lives.
 *
 * Reuses `createIpcClient`'s demultiplexing (`client.startSession()` per
 * session; the bridge already spawns one subprocess per call) rather than
 * reimplementing it — this module only adds the "N of them, tracked
 * together" layer on top.
 *
 * ## Extension seams for sub-wave 2B
 *
 * Read this before adding a new session-scoped UI surface; every seam below
 * is keyed by the same session id `list()`/`activeId` already expose — there
 * is no separate "current session" concept to keep in sync.
 *
 *  - **Badge slot.** `SessionSummary.pendingApprovals` is a placeholder
 *    counter (always 0 until T4 lands). `gui/src/components/app/
 *    session-sidebar.tsx` already renders it into a `Badge` next to each
 *    session row. T4's approval inbox should call `setPendingApprovals(id,
 *    count)` below as `extension_ui_request`/response frames arrive and
 *    resolve — wire the count through that method, not a new UI.
 *  - **Header slot.** `gui/src/components/session/session-view.tsx` renders
 *    a `<header>` per active session (currently just its title). Model/
 *    thinking-level pickers add controls there, keyed by the `sessionId`
 *    prop that component already takes.
 *  - **Side-panel slot.** `gui/src/components/app/app-shell.tsx` lays out
 *    `<SessionSidebar> | <SessionView>` inside `SidebarInset`. A subagent
 *    panel slots in as a third child there, driven off the same `activeId`
 *    `useSessions()` already exposes.
 */
import type { IpcClient, IpcSessionHandle } from "../client";
import { Transcript } from "./transcript";
import type { RpcSession } from "./session";

export type SessionStatus = "idle" | "running" | "error" | "exited";

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  /** Placeholder counter other tickets (the approval inbox, T4) populate via
   * `setPendingApprovals`; always 0 until then. */
  pendingApprovals: number;
}

interface SessionRecord {
  readonly id: string;
  readonly title: string;
  handle: IpcSessionHandle | null;
  transcript: Transcript | null;
  /** Set once `client.startSession()` rejects for this session; wins over
   * the transcript-derived status (there is no transcript to derive from). */
  startError: string | null;
  /** Set once the subprocess exits on its own (transport-level), as
   * distinct from an explicit `closeSession` call — that removes the
   * record instead of flagging it. */
  exited: boolean;
  pendingApprovals: number;
  unsubscribeTranscript: () => void;
  unsubscribeExit: () => void;
}

export interface SessionsStore {
  /**
   * Start a new session's subprocess and register it. Returns its id
   * synchronously; the spawn/ready handshake happens in the background and
   * is reflected in `list()`'s `status` (`"idle"` while connecting, then
   * `"running"`/`"idle"` once its `Transcript` exists, or `"error"` if the
   * handshake fails). Becomes the active session. No cap (ADR-0005).
   */
  createSession(): string;
  /**
   * Close and remove a session: kills its subprocess, disposes its
   * transcript, and drops it from `list()`. If it was the active session,
   * the next remaining session (if any) becomes active. No-op for an
   * unknown id.
   */
  closeSession(id: string): Promise<void>;
  /** Make `id` the active session. No-op for an unknown id. */
  selectSession(id: string): void;
  /** Snapshot of every tracked session, in creation order. Stable
   * reference between notifications (safe as a `useSyncExternalStore`
   * snapshot). */
  list(): SessionSummary[];
  /** The `Transcript` for a session, or `undefined` before its subprocess
   * is ready, after it fails to start, or once it's been closed. */
  getTranscript(id: string): Transcript | undefined;
  /**
   * The live `RpcSession` for a session — direct `command`/`onEvent` access
   * for session-scoped features (approval inbox T4, subagent panel T12,
   * model/thinking pickers T13, steering T5). `undefined` before the
   * subprocess is ready, after a start failure, or once closed.
   */
  getSession(id: string): RpcSession | undefined;
  /** The currently active session id, or `null` when none exist. */
  readonly activeId: string | null;
  /** Set a session's `pendingApprovals` count (extension seam for T4's
   * approval inbox — see the top-of-file comment). No-op for an unknown id. */
  setPendingApprovals(id: string, count: number): void;
  /** Register for change notifications: any session's status/approval
   * count, list membership, or the active id. Returns an unsubscribe
   * function. */
  subscribe(listener: () => void): () => void;
}

/**
 * `client` is the same `IpcClient` the rest of the app already constructs
 * via `createIpcClient(bridge)` — this store adds no transport of its own.
 */
export function createSessionsStore(client: IpcClient): SessionsStore {
  const sessions = new Map<string, SessionRecord>();
  const order: string[] = [];
  const listeners = new Set<() => void>();
  let activeId: string | null = null;
  let sessionCounter = 0;
  let cachedList: SessionSummary[] = [];

  function deriveStatus(record: SessionRecord): SessionStatus {
    if (record.startError !== null) return "error";
    if (record.exited) return "exited";
    return record.transcript?.getSnapshot().running ? "running" : "idle";
  }

  function summarize(record: SessionRecord): SessionSummary {
    return {
      id: record.id,
      title: record.title,
      status: deriveStatus(record),
      pendingApprovals: record.pendingApprovals,
    };
  }

  /** Recomputes the cached list snapshot and notifies every subscriber.
   * Called after any mutation, however small — sessions are few enough
   * (human-driven concurrency, not thousands of rows) that rebuilding the
   * whole list is simpler than tracking per-field dirtiness. */
  function publish(): void {
    cachedList = order.map((id) => summarize(sessions.get(id)!));
    for (const listener of listeners) listener();
  }

  return {
    createSession(): string {
      const id = `session-${++sessionCounter}`;
      const record: SessionRecord = {
        id,
        title: `Session ${sessionCounter}`,
        handle: null,
        transcript: null,
        startError: null,
        exited: false,
        pendingApprovals: 0,
        unsubscribeTranscript: () => {},
        unsubscribeExit: () => {},
      };
      sessions.set(id, record);
      order.push(id);
      activeId = id;
      publish();

      void client
        .startSession()
        .then((handle) => {
          // closeSession() already ran while the subprocess was still
          // starting: shut it straight back down instead of leaking it.
          if (!sessions.has(id)) {
            void handle.close();
            return;
          }
          record.handle = handle;
          record.transcript = new Transcript(handle.session);
          record.unsubscribeTranscript = record.transcript.subscribe(() => publish());
          record.unsubscribeExit = handle.session.onExit(() => {
            record.exited = true;
            publish();
          });
          publish();
        })
        .catch((error: unknown) => {
          if (!sessions.has(id)) return;
          record.startError = error instanceof Error ? error.message : String(error);
          publish();
        });

      return id;
    },

    async closeSession(id: string): Promise<void> {
      const record = sessions.get(id);
      if (!record) return;
      sessions.delete(id);
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
      if (activeId === id) activeId = order[0] ?? null;
      record.unsubscribeTranscript();
      record.unsubscribeExit();
      record.transcript?.dispose();
      publish();
      try {
        await record.handle?.close();
      } catch {
        // The subprocess may already be gone (e.g. it crashed before this
        // explicit close arrived); the record is already removed above, so
        // a failed kill of an already-dead process isn't caller-facing.
      }
    },

    selectSession(id: string): void {
      if (!sessions.has(id) || activeId === id) return;
      activeId = id;
      publish();
    },

    list(): SessionSummary[] {
      return cachedList;
    },

    getTranscript(id: string): Transcript | undefined {
      return sessions.get(id)?.transcript ?? undefined;
    },

    getSession(id: string): RpcSession | undefined {
      return sessions.get(id)?.handle?.session ?? undefined;
    },

    get activeId(): string | null {
      return activeId;
    },

    setPendingApprovals(id: string, count: number): void {
      const record = sessions.get(id);
      if (!record || record.pendingApprovals === count) return;
      record.pendingApprovals = count;
      publish();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
