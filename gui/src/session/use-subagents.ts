/**
 * Bridges the framework-agnostic `SubagentTracker`/`SubagentsStore`
 * (`@omp-gui/ipc`, T12, issue #13) into React, mirroring `use-sessions.ts`'s
 * chained-`useSyncExternalStore` pattern: an outer subscription pulls the
 * per-session `SubagentsStore` itself, an inner one subscribes to that
 * store's own notifications.
 *
 * The outer subscription is `store.subscribe` (the `SessionsStore` itself,
 * not a separate tracker-level subscribe) deliberately: `SubagentTracker`
 * attaches its `SubagentsStore`s from *inside* its own `store.subscribe`
 * listener (registered when `getSubagentTracker` first constructs it), and
 * that listener runs synchronously as part of the same `store.subscribe`
 * notification loop — by the time React re-renders off `store.subscribe`
 * and calls `getSubagentsSnapshot` below, the tracker has always already
 * reconciled. No second subscription surface is needed.
 *
 * A new file rather than an addition to `use-sessions.ts`: `SubagentTracker`
 * is `@omp-gui/ipc`'s own per-`SessionsStore` singleton (`getSubagentTracker`
 * caches it in a `WeakMap`, same shape as `approvals.ts`'s
 * `getApprovalRegistry`) rather than a field `SessionsStore` constructs
 * itself, so these hooks pull from that accessor directly instead of a
 * `SessionsStore` method.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  getSubagentTracker,
  type SessionsStore,
  type SubagentStreamEntry,
  type SubagentSummary,
} from "@omp-gui/ipc";

const EMPTY_SUMMARIES: SubagentSummary[] = [];
const EMPTY_STREAM: SubagentStreamEntry[] = [];

/** The live roster of subagents spawned by `sessionId`, in spawn order.
 * Empty (never `undefined`) before the tracker has attached to that
 * session's `RpcSession`, once the session closes, or when `sessionId` is
 * `null` (no active session). */
export function useSubagentSummaries(
  store: SessionsStore,
  sessionId: string | null,
): SubagentSummary[] {
  const tracker = getSubagentTracker(store);

  const getSubagentsSnapshot = useCallback(
    () => (sessionId ? tracker.getSubagents(sessionId) : undefined),
    [tracker, sessionId],
  );
  const subagents = useSyncExternalStore(store.subscribe, getSubagentsSnapshot);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (subagents ? subagents.subscribe(onStoreChange) : () => {}),
    [subagents],
  );
  const getSnapshot = useCallback(
    () => (subagents ? subagents.list() : EMPTY_SUMMARIES),
    [subagents],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** One subagent's live message stream (the drill-in view). Empty (never
 * `undefined`) before it's available, so callers can render an empty state
 * instead of branching on `undefined` themselves. */
export function useSubagentStream(
  store: SessionsStore,
  sessionId: string | null,
  subagentId: string | null,
): SubagentStreamEntry[] {
  const tracker = getSubagentTracker(store);

  const getSubagentsSnapshot = useCallback(
    () => (sessionId ? tracker.getSubagents(sessionId) : undefined),
    [tracker, sessionId],
  );
  const subagents = useSyncExternalStore(store.subscribe, getSubagentsSnapshot);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subagents && subagentId ? subagents.subscribeStream(subagentId, onStoreChange) : () => {},
    [subagents, subagentId],
  );
  const getSnapshot = useCallback(
    () =>
      subagents && subagentId ? (subagents.getStream(subagentId) ?? EMPTY_STREAM) : EMPTY_STREAM,
    [subagents, subagentId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
