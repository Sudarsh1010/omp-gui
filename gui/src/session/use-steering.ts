/**
 * Bridges the framework-agnostic `SteeringController` (`@omp-gui/ipc`, T5,
 * issue #6) into React: one per mounted `Composer`, mirroring `use-sessions.
 * ts`'s `useSessionTranscript` shape (subscribe to the store for the
 * session's live `RpcSession`, then subscribe to that object's own
 * `subscribe`/`getSnapshot`). Kept in its own file rather than folded into
 * `use-sessions.ts` so that file stays limited to the `SessionsStore`'s own
 * directly exposed state (list/summary/transcript).
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createSteeringController,
  type QueueDrainMode,
  type SessionsStore,
  type SteeringInterruptMode,
  type SteeringSnapshot,
} from "@omp-gui/ipc";

const EMPTY_SNAPSHOT: SteeringSnapshot = {
  ready: false,
  queueModes: {
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
  },
  queuedMessageCount: 0,
  pending: { steer: false, followUp: false, abort: false, abortAndPrompt: false },
  lastError: null,
};

export interface Steering {
  snapshot: SteeringSnapshot;
  steer: (text: string) => void;
  followUp: (text: string, queueMode: QueueDrainMode) => void;
  abortAndPrompt: (text: string) => void;
  setSteeringMode: (mode: QueueDrainMode) => void;
  setFollowUpMode: (mode: QueueDrainMode) => void;
  setInterruptMode: (mode: SteeringInterruptMode) => void;
}

/**
 * One session's live steering controller, adapted to React. Builds a fresh
 * `SteeringController` whenever the session's underlying `RpcSession`
 * instance changes and disposes it on unmount/change. Unlike `Transcript`,
 * this controller's state is small and re-hydrates cheaply from
 * `get_state`, so — deliberately — it has no home inside `SessionsStore`
 * the way `Transcript` does: `app-shell.tsx` already remounts the whole
 * `SessionView` subtree on session switch (`key={activeId}`), which is all
 * the lifecycle this needs.
 */
export function useSteering(store: SessionsStore, sessionId: string): Steering {
  const getSessionSnapshot = useCallback(() => store.getSession(sessionId), [store, sessionId]);
  const session = useSyncExternalStore(store.subscribe, getSessionSnapshot);

  const controller = useMemo(
    () => (session ? createSteeringController(session) : undefined),
    [session],
  );
  useEffect(() => {
    return () => controller?.dispose();
  }, [controller]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (controller ? controller.subscribe(onStoreChange) : () => {}),
    [controller],
  );
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? EMPTY_SNAPSHOT, [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return {
    snapshot,
    steer: useCallback((text: string) => void controller?.steer(text), [controller]),
    followUp: useCallback(
      (text: string, queueMode: QueueDrainMode) => void controller?.followUp(text, queueMode),
      [controller],
    ),
    abortAndPrompt: useCallback(
      (text: string) => void controller?.abortAndPrompt(text),
      [controller],
    ),
    setSteeringMode: useCallback(
      (mode: QueueDrainMode) => void controller?.setSteeringMode(mode),
      [controller],
    ),
    setFollowUpMode: useCallback(
      (mode: QueueDrainMode) => void controller?.setFollowUpMode(mode),
      [controller],
    ),
    setInterruptMode: useCallback(
      (mode: SteeringInterruptMode) => void controller?.setInterruptMode(mode),
      [controller],
    ),
  };
}
