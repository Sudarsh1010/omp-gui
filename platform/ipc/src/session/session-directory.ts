/**
 * Session switcher core (T7, issue #8): reads past session files from disk
 * through the Shell Bridge and drives `switch_session` to resume one into a
 * live `SessionsStore` session, enforcing ADR-0005's single-writer guard.
 * Framework-agnostic like `sessions-store.ts` itself (no React import
 * here) — `gui/src/session/use-session-directory.ts` is the thin React
 * bridge, not where this state actually lives.
 *
 * ## Ownership registry split (ADR-0005)
 *
 * ADR-0005 asks for a registry of which live process owns which session
 * file, refusing to drive one owned elsewhere and offering read-only
 * replay instead. That splits across two independent halves:
 *
 *  - **This app's own sessions** (tracked here, in-memory, synchronously
 *    queryable via {@link SessionDirectory.ownerOf}): this module already
 *    knows exactly which `SessionsStore` session is driving which file — it
 *    made the `switch_session` call. Release is driven by watching *the
 *    store's* list/status rather than `RpcSession.onExit` directly:
 *    `RpcSession.close()` (which `SessionsStore.closeSession()` calls)
 *    detaches from the transport *before* the subprocess actually dies —
 *    "does not kill the subprocess (transport owner's job)" is its own
 *    documented contract — so `onExit` listeners never fire for an
 *    explicit close, only for a natural crash. The store's `list()`
 *    reliably reflects *both* teardown paths (removed on explicit close,
 *    `status: "exited"`/`"error"` on a natural one), so that's the one
 *    signal this module actually watches. This is the deterministic half,
 *    and the one the seam tests exercise directly against two real
 *    (Bun-spawned) omp subprocesses, no Tauri runtime involved at all.
 *  - **A genuinely external process** (e.g. the user's terminal `omp` on
 *    the same project) — the case ADR-0005 calls out by name. This module
 *    has no bookkeeping for a process it never spawned; `resume()` asks the
 *    Shell Bridge's best-effort `probeForeignSessionLock` (Tauri/Rust-only,
 *    `crates/shell/src/sessions.rs`) when available, and simply skips that
 *    check when it isn't (e.g. `nodeBridge` in tests).
 */
import type { ShellBridge, SessionFileEntry, SessionPreview } from "../bridge/shell-bridge";
import type { RpcSession } from "./session";
import type { SessionsStore } from "./sessions-store";

/** Whether a session file is currently being driven by one of this app's
 * own live sessions — see the module doc for what this can and can't see. */
export type SessionOwnership =
  | { state: "free" }
  /** A `resume()` call on this path is in flight (reserved synchronously,
   * before the switch itself has been confirmed) — treated the same as
   * `ownedByApp` by callers deciding whether to offer another resume. */
  | { state: "pending" }
  | { state: "ownedByApp"; sessionId: string };

export type ResumeResult =
  | { ok: true; sessionId: string }
  /** Refused: `path` is guarded (owned by this app or, best-effort,
   * another process) or the switch itself was cancelled. Never thrown —
   * only a genuine protocol/IO failure rejects `resume()`'s promise. */
  | { ok: false; readOnly: true; reason: string };

export interface SessionDirectory {
  /** Snapshot of on-disk session files, newest first. Empty until the
   * first `refresh()` resolves. Stable reference between notifications
   * (safe as a `useSyncExternalStore` snapshot). */
  list(): SessionFileEntry[];
  /**
   * Re-scan disk via the bridge's `listSessionFiles`. No-op (list left as
   * it was) if the bridge doesn't implement it — there is no session
   * directory feature to offer without it.
   */
  refresh(): Promise<void>;
  /** Whether `path` is currently claimed by one of this app's own live
   * sessions. Synchronous, in-memory only (see module doc). */
  ownerOf(path: string): SessionOwnership;
  /**
   * Resume `path` into a fresh `SessionsStore` session and switch to it.
   * Refuses (`{ok:false, readOnly:true}`) if `path` is already owned by
   * one of this app's own sessions, or — best-effort, only when the
   * bridge implements `probeForeignSessionLock` — by a process outside
   * this app. Rejects (throws) only on a genuine protocol/IO failure.
   */
  resume(path: string): Promise<ResumeResult>;
  /**
   * Bounded, read-only reconstruction of `path`'s early messages via the
   * bridge's `readSessionPreview` — the switcher's "view read-only"
   * affordance for a guarded file. Rejects if the bridge doesn't
   * implement it.
   */
  preview(path: string): Promise<SessionPreview>;
  /** Register for change notifications: list refreshes and ownership
   * changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Resolves once `id`'s `RpcSession` becomes available, or `undefined` if
 * its subprocess failed to start or the wait times out. `createSession()`
 * returns synchronously while the actual spawn/ready handshake happens in
 * the background (`sessions-store.ts`), so callers that need the session
 * itself (to send `switch_session`) have to wait for it — mirrors
 * `sessions-store.test.ts`'s own `waitForStore` helper.
 */
function waitForSessionReady(
  store: SessionsStore,
  id: string,
  timeoutMs = 15_000,
): Promise<RpcSession | undefined> {
  const existing = store.getSession(id);
  if (existing) return Promise.resolve(existing);
  const startSummary = store.list().find((session) => session.id === id);
  if (startSummary?.status === "error") return Promise.resolve(undefined);

  const { promise, resolve } = Promise.withResolvers<RpcSession | undefined>();
  const unsubscribe = store.subscribe(() => {
    const session = store.getSession(id);
    const current = store.list().find((s) => s.id === id);
    if (session || current?.status === "error" || !current) {
      clearTimeout(timer);
      unsubscribe();
      resolve(session);
    }
  });
  const timer = setTimeout(() => {
    unsubscribe();
    resolve(store.getSession(id));
  }, timeoutMs);

  return promise;
}

/**
 * `bridge` supplies the disk listing/foreign-lock probe (Shell Bridge);
 * `store` is the same `SessionsStore` the rest of the app already
 * constructed via `createSessionsStore(client)` — resuming a session
 * drives it through that store rather than opening a second, parallel
 * subprocess-tracking path.
 */
export function createSessionDirectory(
  bridge: ShellBridge,
  store: SessionsStore,
): SessionDirectory {
  let entries: SessionFileEntry[] = [];
  /** `null` while a `resume()` reservation is pending, a session id once
   * the switch has actually landed. */
  const claims = new Map<string, string | null>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function releasePendingReservation(path: string): void {
    if (claims.get(path) === null) claims.delete(path);
  }

  /**
   * Drops any claim whose backing `SessionsStore` session has gone away
   * (closed explicitly) or stopped running (exited/errored) — see the
   * module doc for why the store's list/status, not `RpcSession.onExit`,
   * is the one signal that covers every teardown path. Runs on every store
   * notification; cheap at this scale (a human's own resumed sessions,
   * not thousands).
   */
  function reconcileClaims(): void {
    let released = false;
    for (const [path, claim] of claims) {
      if (claim === null) continue;
      const summary = store.list().find((session) => session.id === claim);
      if (!summary || summary.status === "exited" || summary.status === "error") {
        claims.delete(path);
        released = true;
      }
    }
    if (released) notify();
  }
  store.subscribe(reconcileClaims);

  return {
    list(): SessionFileEntry[] {
      return entries;
    },

    async refresh(): Promise<void> {
      if (!bridge.listSessionFiles) return;
      entries = await bridge.listSessionFiles();
      notify();
    },

    ownerOf(path: string): SessionOwnership {
      const claim = claims.get(path);
      if (claim === undefined) return { state: "free" };
      if (claim === null) return { state: "pending" };
      return { state: "ownedByApp", sessionId: claim };
    },

    async resume(path: string): Promise<ResumeResult> {
      if (claims.has(path)) {
        return { ok: false, readOnly: true, reason: "already open in this app" };
      }
      claims.set(path, null);
      notify();

      try {
        if (bridge.probeForeignSessionLock) {
          const probe = await bridge.probeForeignSessionLock(path);
          if (probe.locked) {
            releasePendingReservation(path);
            notify();
            return {
              ok: false,
              readOnly: true,
              reason: `owned by another process (pid ${probe.pids.join(", ")})`,
            };
          }
        }

        const sessionId = store.createSession();
        const session = await waitForSessionReady(store, sessionId);
        if (!session) {
          void store.closeSession(sessionId);
          releasePendingReservation(path);
          notify();
          return { ok: false, readOnly: true, reason: "session failed to start" };
        }

        const response = await session.command({ type: "switch_session", sessionPath: path });
        if (response.data.cancelled) {
          await store.closeSession(sessionId);
          releasePendingReservation(path);
          notify();
          return {
            ok: false,
            readOnly: true,
            reason: "switch was cancelled (the new session had an operation in flight)",
          };
        }

        claims.set(path, sessionId);
        notify();
        return { ok: true, sessionId };
      } catch (error) {
        releasePendingReservation(path);
        notify();
        throw error;
      }
    },

    preview(path: string): Promise<SessionPreview> {
      if (!bridge.readSessionPreview) {
        return Promise.reject(
          new Error("this bridge does not support read-only session previews"),
        );
      }
      return bridge.readSessionPreview(path);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
