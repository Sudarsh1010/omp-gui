/**
 * Bridges `SettingsController` (`@omp-gui/ipc`, #24, issue #19) into React
 * via `useSyncExternalStore`, mirroring `use-app-preferences.ts`'s idiom.
 * Unlike the App Preferences controller (one process-wide singleton on the
 * router context), the settings controller is constructed once per
 * Settings route mount (`routes/settings.tsx`, disposed on unmount) — this
 * hook takes it as a prop and layers on the reload-on-mount-and-focus
 * staleness policy ADR-0011 specifies ("Re-read on route entry and window
 * focus; no watcher, no polling").
 */
import { useEffect, useSyncExternalStore } from "react";
import type { SettingsController, SettingsSnapshot } from "@omp-gui/ipc";

export function useSettings(controller: SettingsController): SettingsSnapshot {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);

  useEffect(() => {
    void controller.reload();
    const onFocus = () => void controller.reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [controller]);

  return snapshot;
}
