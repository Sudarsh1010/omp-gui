/**
 * Bridges `ModelSelection` (`@omp-gui/ipc`, T13, issue #14) into React,
 * mirroring `use-sessions.ts`'s per-slice `useSyncExternalStore` pattern
 * (kept in its own file rather than added there to avoid touching a file
 * other sub-wave-2B tickets are also extending concurrently).
 *
 * One `ModelSelection` is created per `sessionId` once its `RpcSession`
 * exists, and disposed when the session changes or goes away — it is never
 * rebuilt on every render, and never outlives the session it was built
 * from.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createModelSelection,
  EMPTY_MODEL_SELECTION_SNAPSHOT,
  type ModelSelectionSnapshot,
  type SessionsStore,
  type SessionThinkingLevel,
} from "@omp-gui/ipc";

export interface UseModelSelectionResult extends ModelSelectionSnapshot {
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: SessionThinkingLevel) => Promise<void>;
}

export function useModelSelection(store: SessionsStore, sessionId: string): UseModelSelectionResult {
  const getSessionSnapshot = useCallback(() => store.getSession(sessionId), [store, sessionId]);
  const session = useSyncExternalStore(store.subscribe, getSessionSnapshot);

  const selection = useMemo(() => (session ? createModelSelection(session) : undefined), [session]);
  useEffect(() => selection?.dispose, [selection]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (selection ? selection.subscribe(onStoreChange) : () => {}),
    [selection],
  );
  const getSnapshot = useCallback(
    () => (selection ? selection.getSnapshot() : EMPTY_MODEL_SELECTION_SNAPSHOT),
    [selection],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const setModel = useCallback(
    (provider: string, modelId: string) => selection?.setModel(provider, modelId) ?? Promise.resolve(),
    [selection],
  );
  const setThinkingLevel = useCallback(
    (level: SessionThinkingLevel) => selection?.setThinkingLevel(level) ?? Promise.resolve(),
    [selection],
  );

  return { ...snapshot, setModel, setThinkingLevel };
}
