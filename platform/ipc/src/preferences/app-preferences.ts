/**
 * App Preferences controller (T20, issue #20; ADR-0011): a framework-
 * agnostic snapshot/subscribe/dispose wrapper around the Shell Bridge's
 * `preferencesRead`/`preferencesWrite` commands, mirroring the shape of the
 * session controllers in `../session/*.ts` (`createModelSelection`,
 * `createLoginController`) even though this one binds to no `RpcSession` —
 * App Preferences is process-wide, not per-session, so one instance is
 * constructed in `main.tsx` off the app's single `ShellBridge` and carried
 * on the router context (`preferences`) for every Settings route.
 *
 * There is no server-pushed change event for this file (unlike omp
 * config, it is never edited from the terminal) — `reload()` is the only
 * way to pick up an out-of-band edit.
 */
import type { AppPreferences, ShellBridge } from "../bridge/shell-bridge";

export type AppPreferencesStatus = "loading" | "ready" | "error";

export interface AppPreferencesSnapshot {
  status: AppPreferencesStatus;
  prefs: AppPreferences;
  /** Message from the most recently failed `reload`/`update`; cleared on
   * the next successful one. */
  error: string | undefined;
}

/** Mirrors `crates/shell/src/preferences.rs`'s `AppPreferences::default()`. */
export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  theme: "system",
  ompPath: null,
  chromiumPath: null,
  defaultWorkingDirectory: null,
};

/** Shared until the first `emit` replaces the reference — never mutated,
 * so sharing it is safe (mirrors `models.ts`'s `EMPTY_MODEL_SELECTION_SNAPSHOT`). */
export const EMPTY_APP_PREFERENCES_SNAPSHOT: AppPreferencesSnapshot = {
  status: "loading",
  prefs: DEFAULT_APP_PREFERENCES,
  error: undefined,
};

export interface AppPreferencesController {
  snapshot(): AppPreferencesSnapshot;
  /** Register for snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-read the preferences file, replacing the snapshot with whatever is
   * on disk right now. */
  reload(): Promise<void>;
  /** Merges `patch` onto the current snapshot's `prefs`, writes it, and
   * refreshes the snapshot from the value the write returns (which may
   * differ if another writer raced it — last-writer-wins, matching the
   * Settings staleness policy). */
  update(patch: Partial<AppPreferences>): Promise<AppPreferences>;
  /** Drop every registered listener. There is nothing else to unsubscribe
   * from (no underlying event stream), so this is safe to skip, but every
   * other Settings/session controller exposes one — kept for parity. */
  dispose(): void;
}

function preferencesBridge(
  bridge: ShellBridge,
): Required<Pick<ShellBridge, "preferencesRead" | "preferencesWrite">> {
  if (!bridge.preferencesRead || !bridge.preferencesWrite) {
    throw new Error("this ShellBridge does not implement App Preferences");
  }
  return { preferencesRead: bridge.preferencesRead, preferencesWrite: bridge.preferencesWrite };
}

/**
 * Creates an `AppPreferencesController` bound to one `ShellBridge`. Fetches
 * the preferences file immediately; call `dispose()` when the owning app
 * shell tears down (in practice, never — one instance lives for the app's
 * whole lifetime).
 */
export function createAppPreferencesController(bridge: ShellBridge): AppPreferencesController {
  let snapshot = EMPTY_APP_PREFERENCES_SNAPSHOT;
  const listeners = new Set<() => void>();

  const emit = (next: Partial<AppPreferencesSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const reload = async () => {
    try {
      const prefs = await preferencesBridge(bridge).preferencesRead();
      emit({ status: "ready", prefs, error: undefined });
    } catch (error) {
      emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  };

  void reload();

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload,
    async update(patch) {
      const merged: AppPreferences = { ...snapshot.prefs, ...patch };
      try {
        const written = await preferencesBridge(bridge).preferencesWrite(merged);
        emit({ status: "ready", prefs: written, error: undefined });
        return written;
      } catch (error) {
        emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    dispose() {
      listeners.clear();
    },
  };
}
