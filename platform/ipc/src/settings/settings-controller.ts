/**
 * Settings controller (#24, issue #19; ADR-0011): a framework-agnostic
 * snapshot/subscribe/dispose wrapper around the Shell Bridge's
 * `configList`/`configSet`/`configReset` commands, mirroring
 * `AppPreferencesController`'s idiom (`../preferences/app-preferences.ts`)
 * but bound to omp's own config rather than the app-owned preferences
 * file. There is no server-pushed change event for omp's config (unlike a
 * running rpc-ui session's frames) — `reload()` is the only way to pick
 * up an out-of-band edit (a terminal `omp config set`, or another
 * window), called by the GUI on route entry and window `focus`
 * (ADR-0011's staleness policy).
 */
import { BridgeCommandError, type ConfigEntry, type ShellBridge } from "../bridge/shell-bridge";
import type { CliError } from "../bindings/bindings.gen";
import { serializeConfigValue } from "./serialize";

export type SettingsStatus = "loading" | "ready" | "error";

/** Per-row transient UI state, keyed by config key. `saved` self-clears
 * after `SAVED_INDICATOR_MS` so the quiet "Saved" text beside a control
 * (issue #19 story #10) doesn't linger. */
export interface RowState {
  pending: boolean;
  saved: boolean;
  rejected?: string;
}

const IDLE_ROW: RowState = { pending: false, saved: false };

export interface SettingsSnapshot {
  status: SettingsStatus;
  entries: ReadonlyMap<string, ConfigEntry>;
  error?: { stage: string; message: string };
  rows: ReadonlyMap<string, RowState>;
}

export const EMPTY_SETTINGS_SNAPSHOT: SettingsSnapshot = {
  status: "loading",
  entries: new Map(),
  error: undefined,
  rows: new Map(),
};

export interface SettingsController {
  snapshot(): SettingsSnapshot;
  /** Register for snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-read the full config list, replacing every entry with whatever
   * omp reports right now. */
  reload(): Promise<void>;
  /**
   * Serializes `value` per the entry's own type
   * (`platform/ipc/src/settings/serialize.ts`) and writes it. On
   * rejection, the row's `rejected` message is set and `entries` is left
   * untouched, so the calling control reverts to the last-known-good
   * value rather than the rejected one.
   */
  set(key: string, value: unknown): Promise<void>;
  /** Restore `key` to omp's current schema default. */
  reset(key: string): Promise<void>;
  /**
   * Removes `key` from the global config file entirely (distinct from
   * `reset`, which writes an explicit default value in the record
   * itself) — issue #19 story #13's "per-row action that returns a
   * setting to omp's current default, labelled by what it actually
   * does", true unset now that the pinned binary carries `config unset`.
   * Re-lists afterward so the row's value reflects the schema default
   * `config unset` leaves in its place, and marks the row `saved`.
   */
  unset(key: string): Promise<void>;
  dispose(): void;
}

/** How long the quiet "Saved" indicator stays up beside a control after a
 * successful write (issue #19 story #10). */
const SAVED_INDICATOR_MS = 1500;

function configBridge(
  bridge: ShellBridge,
): Required<Pick<ShellBridge, "configList" | "configSet" | "configReset" | "configUnset">> {
  if (!bridge.configList || !bridge.configSet || !bridge.configReset || !bridge.configUnset) {
    throw new Error("this ShellBridge does not implement the config bridge");
  }
  return {
    configList: bridge.configList,
    configSet: bridge.configSet,
    configReset: bridge.configReset,
    configUnset: bridge.configUnset,
  };
}

/** Narrows a `BridgeCommandError<CliError>` into the snapshot's
 * `{stage, message}` shape; `Rejected` (no stage of its own — it's omp's
 * validation, not a transport stage) reports `"rejected"` so a degraded
 * `SectionError` still has something to show under "stage". */
function describeError(error: unknown): { stage: string; message: string } {
  if (error instanceof BridgeCommandError) {
    const cliError = error.error as CliError;
    return cliError.type === "unavailable"
      ? { stage: cliError.stage, message: cliError.message }
      : { stage: "rejected", message: cliError.message };
  }
  return { stage: "unknown", message: error instanceof Error ? error.message : String(error) };
}

function rejectionMessage(error: unknown): string {
  if (error instanceof BridgeCommandError) {
    return (error.error as CliError).message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a `SettingsController` bound to one `ShellBridge`. Fetches
 * `configList()` immediately; call `dispose()` once the owning route
 * unmounts (clears pending "Saved" timers along with the listener set).
 */
export function createSettingsController(bridge: ShellBridge): SettingsController {
  let snapshot: SettingsSnapshot = EMPTY_SETTINGS_SNAPSHOT;
  const listeners = new Set<() => void>();
  // `NodeJS.Timeout`, not DOM's `number`: `@types/node`'s global timer
  // declarations take precedence in this package (it's node-runtime code
  // driving seam tests and the Node bridge, unlike `gui`'s browser-only
  // `relay-toggle.tsx`/`theme-row.tsx`, which really do resolve to `number`).
  const savedTimers = new Map<string, NodeJS.Timeout>();

  const emit = (next: Partial<SettingsSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const setRow = (key: string, patch: Partial<RowState>) => {
    const rows = new Map(snapshot.rows);
    rows.set(key, { ...(rows.get(key) ?? IDLE_ROW), ...patch });
    emit({ rows });
  };

  const scheduleSavedClear = (key: string) => {
    clearTimeout(savedTimers.get(key));
    savedTimers.set(
      key,
      setTimeout(() => {
        setRow(key, { saved: false });
        savedTimers.delete(key);
      }, SAVED_INDICATOR_MS),
    );
  };

  const reload = async () => {
    try {
      const list = await configBridge(bridge).configList();
      const entries = new Map(list.map((entry) => [entry.key, entry] as const));
      emit({ status: "ready", entries, error: undefined });
    } catch (error) {
      emit({ status: "error", error: describeError(error) });
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
    async set(key, value) {
      const entry = snapshot.entries.get(key);
      const serialized = serializeConfigValue(entry?.valueType ?? "string", value);
      setRow(key, { pending: true, rejected: undefined });
      try {
        const updated = await configBridge(bridge).configSet(key, serialized);
        const entries = new Map(snapshot.entries);
        entries.set(key, updated);
        emit({ entries });
        setRow(key, { pending: false, saved: true, rejected: undefined });
        scheduleSavedClear(key);
      } catch (error) {
        setRow(key, { pending: false, saved: false, rejected: rejectionMessage(error) });
      }
    },
    async reset(key) {
      setRow(key, { pending: true, rejected: undefined });
      try {
        const updated = await configBridge(bridge).configReset(key);
        const entries = new Map(snapshot.entries);
        entries.set(key, updated);
        emit({ entries });
        setRow(key, { pending: false, saved: true, rejected: undefined });
        scheduleSavedClear(key);
      } catch (error) {
        setRow(key, { pending: false, saved: false, rejected: rejectionMessage(error) });
      }
    },
    async unset(key) {
      setRow(key, { pending: true, rejected: undefined });
      try {
        await configBridge(bridge).configUnset(key);
        const list = await configBridge(bridge).configList();
        const entries = new Map(list.map((entry) => [entry.key, entry] as const));
        emit({ entries });
        setRow(key, { pending: false, saved: true, rejected: undefined });
        scheduleSavedClear(key);
      } catch (error) {
        setRow(key, { pending: false, saved: false, rejected: rejectionMessage(error) });
      }
    },
    dispose() {
      listeners.clear();
      for (const timer of savedTimers.values()) clearTimeout(timer);
      savedTimers.clear();
    },
  };
}
