/**
 * Bridges `@omp-gui/ipc`'s per-session `ApprovalInbox` (T4, issue #5) into
 * React, mirroring `use-sessions.ts`'s one-hook-per-slice shape and the
 * `useSessionTranscript` two-level-subscribe pattern: the outer
 * `useSyncExternalStore` (keyed off `store.subscribe`) tracks *which*
 * `ApprovalInbox` instance currently exists for `sessionId`, and the inner
 * one tracks *that instance's* own snapshot.
 *
 * The inbox itself is owned by the store-wide `ApprovalRegistry` (created
 * lazily, keyed by `store` — see `approvals.ts`), not by this hook or its
 * caller's mount lifecycle: a session's queued approvals must keep
 * counting toward its sidebar badge even while its `SessionView` is
 * unmounted (switched away from), exactly like `Transcript`.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  getApprovalRegistry,
  type ApprovalAnswer,
  type ApprovalInboxSnapshot,
  type SessionsStore,
} from "@omp-gui/ipc";

const EMPTY_APPROVALS: ApprovalInboxSnapshot = [];

/** One session's pending-approval queue, plus the action that resolves an
 * entry. `pending` is `[]` before the session's `RpcSession` exists (same
 * window `useSessionTranscript`'s `ready` flag covers) or once it closes. */
export function useApprovalInbox(
  store: SessionsStore,
  sessionId: string,
): {
  pending: ApprovalInboxSnapshot;
  answer: (requestId: string, answer: ApprovalAnswer) => void;
} {
  const registry = getApprovalRegistry(store);
  const getInboxSnapshot = useCallback(() => registry.getInbox(sessionId), [registry, sessionId]);
  const inbox = useSyncExternalStore(store.subscribe, getInboxSnapshot);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (inbox ? inbox.subscribe(onStoreChange) : () => {}),
    [inbox],
  );
  const getSnapshot = useCallback(() => (inbox ? inbox.getSnapshot() : EMPTY_APPROVALS), [inbox]);
  const pending = useSyncExternalStore(subscribe, getSnapshot);

  const answer = useCallback(
    (requestId: string, response: ApprovalAnswer) => inbox?.answer(requestId, response),
    [inbox],
  );

  return { pending, answer };
}
