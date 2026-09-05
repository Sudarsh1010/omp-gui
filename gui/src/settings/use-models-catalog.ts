/**
 * Bridges `ModelsCatalogController` (`@omp-gui/ipc`, #27, issue #19/#27)
 * into React via `useSyncExternalStore`, mirroring `use-accounts.ts`'s
 * per-mount controller lifecycle for a Shell-Bridge-direct controller —
 * constructed here (not a router-context singleton, since it's also bound
 * to the route's own `SettingsController` instance) and disposed on
 * unmount.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createModelsCatalogController,
  type ModelRole,
  type ModelsCatalogSnapshot,
  type SettingsController,
  type ShellBridge,
} from "@omp-gui/ipc";

export interface UseModelsCatalogResult extends ModelsCatalogSnapshot {
  reload: () => Promise<void>;
  setFilter: (text: string) => void;
  setProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  setModelEnabled: (selector: string, enabled: boolean) => Promise<void>;
  setRole: (role: ModelRole, modelSelector: string) => Promise<void>;
}

export function useModelsCatalog(
  bridge: ShellBridge,
  settings: SettingsController,
): UseModelsCatalogResult {
  const controller = useMemo(
    () => createModelsCatalogController(bridge, settings),
    [bridge, settings],
  );
  useEffect(() => controller.dispose, [controller]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const reload = useCallback(() => controller.reload(), [controller]);
  const setFilter = useCallback((text: string) => controller.setFilter(text), [controller]);
  const setProviderEnabled = useCallback(
    (providerId: string, enabled: boolean) => controller.setProviderEnabled(providerId, enabled),
    [controller],
  );
  const setModelEnabled = useCallback(
    (selector: string, enabled: boolean) => controller.setModelEnabled(selector, enabled),
    [controller],
  );
  const setRole = useCallback(
    (role: ModelRole, modelSelector: string) => controller.setRole(role, modelSelector),
    [controller],
  );

  return { ...snapshot, reload, setFilter, setProviderEnabled, setModelEnabled, setRole };
}
