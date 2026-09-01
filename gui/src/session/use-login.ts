/**
 * Bridges `LoginController` (`@omp-gui/ipc`, T14, issue #15) into React,
 * mirroring `use-model-selection.ts`'s per-`sessionId` lifecycle: one
 * controller is created per session once its `RpcSession` exists, and
 * disposed when the session changes or goes away — never rebuilt on every
 * render, never outliving the session it was built from.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createLoginController,
  EMPTY_LOGIN_SNAPSHOT,
  type LoginSnapshot,
  type SessionsStore,
} from "@omp-gui/ipc";

export interface UseLoginResult extends LoginSnapshot {
  refreshProviders: () => Promise<void>;
  login: (providerId: string) => Promise<void>;
  dismissElicitation: () => void;
}

export function useLogin(store: SessionsStore, sessionId: string): UseLoginResult {
  const getSessionSnapshot = useCallback(() => store.getSession(sessionId), [store, sessionId]);
  const session = useSyncExternalStore(store.subscribe, getSessionSnapshot);

  const controller = useMemo(
    () => (session ? createLoginController(session) : undefined),
    [session],
  );
  useEffect(() => controller?.dispose, [controller]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (controller ? controller.subscribe(onStoreChange) : () => {}),
    [controller],
  );
  const getSnapshot = useCallback(
    () => (controller ? controller.getSnapshot() : EMPTY_LOGIN_SNAPSHOT),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const refreshProviders = useCallback(
    () => controller?.refreshProviders() ?? Promise.resolve(),
    [controller],
  );
  const login = useCallback(
    (providerId: string) => controller?.login(providerId) ?? Promise.resolve(),
    [controller],
  );
  const dismissElicitation = useCallback(() => controller?.dismissElicitation(), [controller]);

  return { ...snapshot, refreshProviders, login, dismissElicitation };
}
