/**
 * Bridges `AccountsController` (`@omp-gui/ipc`, T25, issue #19/#25) into
 * React via `useSyncExternalStore`, mirroring `use-app-preferences.ts`'s
 * idiom for a Shell-Bridge-direct (not `RpcSession`-bound) controller.
 * Unlike the App Preferences controller (one process-wide instance on the
 * router context), Accounts is scoped to the Settings route's own mount —
 * this hook constructs and disposes one per mount, matching
 * `use-login.ts`/`use-model-selection.ts`'s per-mount controller
 * lifecycle rather than adding a second global singleton.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createAccountsController, type AccountsSnapshot, type ShellBridge } from "@omp-gui/ipc";

export interface UseAccountsResult extends AccountsSnapshot {
  reload: () => Promise<void>;
  logout: (providerId: string) => Promise<void>;
}

export function useAccounts(bridge: ShellBridge): UseAccountsResult {
  const controller = useMemo(() => createAccountsController(bridge), [bridge]);
  useEffect(() => controller.dispose, [controller]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const reload = useCallback(() => controller.reload(), [controller]);
  const logout = useCallback((providerId: string) => controller.logout(providerId), [controller]);

  return { ...snapshot, reload, logout };
}
