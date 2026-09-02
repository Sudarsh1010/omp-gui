/**
 * Bridges `SessionDirectory` (`@omp-gui/ipc`, T7, issue #8) into React,
 * mirroring `use-sessions.ts`'s `useSyncExternalStore` pattern. Reads the
 * app's shared bridge from router context (`useBridge`) rather than
 * constructing its own `tauriBridge` instance.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createSessionDirectory,
  type SessionDirectory,
  type SessionFileEntry,
  type SessionOwnership,
  type SessionsStore,
} from "@omp-gui/ipc";
import { useBridge } from "@gui/bridge-context";

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
  const bridge = useBridge();
  const directory = useMemo(() => createSessionDirectory(bridge, store), [bridge, store]);
  useEffect(() => directory.dispose, [directory]);
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
