/**
 * Bridges `AppPreferencesController` (`@omp-gui/ipc`, T20, issue #20) into
 * React via `useSyncExternalStore`, mirroring `gui/src/session/use-*.ts`'s
 * idiom for the session controllers. The controller itself is a process-
 * wide singleton constructed once in `main.tsx` and carried on the router
 * context (`preferences`), so this hook takes it as a prop rather than
 * constructing/disposing one per mount.
 */
import { useSyncExternalStore } from "react";
import type { AppPreferencesController, AppPreferencesSnapshot } from "@omp-gui/ipc";

export function useAppPreferences(controller: AppPreferencesController): AppPreferencesSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.snapshot);
}
