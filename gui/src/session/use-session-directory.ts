/**
 * Bridges `SessionDirectory` (`@omp-gui/ipc`, T7, issue #8) into React,
 * mirroring `use-sessions.ts`'s `useSyncExternalStore` pattern. Constructs
 * its own `tauriBridge()` rather than threading one through router
 * context: the bridge is a stateless wrapper over the app-wide
 * `commands`/`events` singletons from `bindings.gen.ts` (see `tauri.ts`),
 * so a second call site here costs nothing and keeps the Past Sessions
 * feature's wiring local to this file instead of widening
 * `__root.tsx`/`main.tsx`'s shared router context for one sidebar section.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  createSessionDirectory,
  tauriBridge,
  type SessionDirectory,
  type SessionFileEntry,
  type SessionOwnership,
  type SessionsStore,
} from "@omp-gui/ipc";

/** The switcher's live view of past session files, plus the loading state
 * around an explicit re-scan. `directory` itself is returned too — its
 * `ownerOf`/`resume`/`preview` methods are already stable across renders
 * (same object as long as `store` doesn't change), so callers use them
 * directly rather than through redundant wrapper callbacks here. */
export function useSessionDirectory(store: SessionsStore): {
  directory: SessionDirectory;
  entries: SessionFileEntry[];
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const directory = useMemo(() => createSessionDirectory(tauriBridge(), store), [store]);
  const entries = useSyncExternalStore(directory.subscribe, directory.list);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await directory.refresh();
    } finally {
      setRefreshing(false);
    }
  }, [directory]);

  return { directory, entries, refreshing, refresh };
}

/**
 * One session file's live ownership state, mirroring
 * `use-sessions.ts`'s `useSessionSummary` shape. Re-renders on *any*
 * directory notification (a list refresh or any path's claim changing),
 * not just this path's own — fine at this list's scale (a human's past
 * sessions, not thousands of rows).
 */
export function useSessionOwnership(directory: SessionDirectory, path: string): SessionOwnership {
  const getOwnershipSnapshot = useCallback(() => directory.ownerOf(path), [directory, path]);
  return useSyncExternalStore(directory.subscribe, getOwnershipSnapshot);
}
