/**
 * Bridges the framework-agnostic `SessionsStore` (`@omp-gui/ipc`, T8, issue
 * #9) into React. One `useSyncExternalStore` subscription per slice of state
 * a consumer needs, all sharing the store's single `subscribe` — cheaper
 * than a combined snapshot object, and each consumer only re-renders when
 * its own slice's reference actually changes.
 *
 * `SessionsStore` is threaded down as an explicit prop from the route that
 * reads it out of router context (`gui/src/routes/index.tsx`), matching
 * this codebase's existing convention of resolving router context once at
 * the route boundary and passing derived values down to plain-prop
 * components (`Composer`/`TranscriptView`) rather than having every
 * descendant read context itself.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  type SessionsStore,
  type SessionSummary,
  type Transcript,
  type TranscriptSnapshot,
} from "@omp-gui/ipc";

const EMPTY_SNAPSHOT: TranscriptSnapshot = { entries: [], running: false, aborting: false };

/** The sidebar's live view of every tracked session, plus the actions it
 * dispatches back into the store. */
export function useSessions(store: SessionsStore): {
  sessions: SessionSummary[];
  activeId: string | null;
  createSession: () => string;
  closeSession: (id: string) => void;
  selectSession: (id: string) => void;
} {
  const getListSnapshot = useCallback(() => store.list(), [store]);
  const getActiveIdSnapshot = useCallback(() => store.activeId, [store]);
  const sessions = useSyncExternalStore(store.subscribe, getListSnapshot);
  const activeId = useSyncExternalStore(store.subscribe, getActiveIdSnapshot);

  const createSession = useCallback(() => store.createSession(), [store]);
  const closeSession = useCallback((id: string) => void store.closeSession(id), [store]);
  const selectSession = useCallback((id: string) => store.selectSession(id), [store]);

  return { sessions, activeId, createSession, closeSession, selectSession };
}

/** One session's summary row (title/status/pendingApprovals), or `undefined`
 * if `sessionId` isn't tracked (e.g. it was just closed). */
export function useSessionSummary(store: SessionsStore, sessionId: string): SessionSummary | undefined {
  const getSummarySnapshot = useCallback(
    () => store.list().find((session) => session.id === sessionId),
    [store, sessionId],
  );
  return useSyncExternalStore(store.subscribe, getSummarySnapshot);
}

/**
 * Bridges one session's `Transcript` — owned by the `SessionsStore`, not by
 * this hook or its caller's mount lifecycle — into React. Returns the same
 * `{ snapshot, sendPrompt, abort }` shape `Composer`/`TranscriptView` already
 * expect, so they don't need to know which hook produced it; the difference
 * is lifecycle only: this hook only *subscribes* to a `Transcript` the store
 * already constructed, it never constructs or disposes one itself, because
 * switching the active session must never tear down one still running in
 * the background.
 *
 * `ready` is `false` until the session's subprocess has completed its
 * ready handshake (`store.getTranscript(sessionId)` is still `undefined`)
 * — distinct from a merely-empty transcript, so callers can show a
 * connecting state instead of composer input that would silently vanish.
 */
export function useSessionTranscript(
  store: SessionsStore,
  sessionId: string,
): {
  snapshot: TranscriptSnapshot;
  ready: boolean;
  sendPrompt: (text: string) => void;
  abort: () => void;
} {
  const getTranscriptSnapshot = useCallback(() => store.getTranscript(sessionId), [store, sessionId]);
  const transcript: Transcript | undefined = useSyncExternalStore(store.subscribe, getTranscriptSnapshot);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (transcript ? transcript.subscribe(onStoreChange) : () => {}),
    [transcript],
  );
  const getSnapshot = useCallback(
    () => (transcript ? transcript.getSnapshot() : EMPTY_SNAPSHOT),
    [transcript],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const sendPrompt = useCallback(
    (text: string) => {
      void transcript?.sendPrompt(text);
    },
    [transcript],
  );
  const abort = useCallback(() => {
    void transcript?.abort();
  }, [transcript]);

  return { snapshot, ready: transcript !== undefined, sendPrompt, abort };
}
