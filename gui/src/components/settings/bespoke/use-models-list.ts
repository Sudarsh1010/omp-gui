/**
 * Tiny local hook the fallback-chains editor (#29) uses to populate its
 * "Add model" picker: fetches `bridge.modelsList()` once per mount, not
 * the full `ModelsCatalogController` (that's bound to a `SettingsController`
 * and the Models section's enable/role state, neither of which this editor
 * needs — it only wants the raw provider/selector list). Falls back to
 * `"unavailable"` when the bridge does not implement `modelsList` or the
 * call rejects, so the editor can fall back to a free-text input.
 */
import { useEffect, useState } from "react";
import type { ModelEntry, ShellBridge } from "@omp-gui/ipc";

export type ModelsListState =
  | { status: "loading" }
  | { status: "ready"; models: ModelEntry[] }
  | { status: "unavailable" };

export function useModelsList(bridge: ShellBridge): ModelsListState {
  const [state, setState] = useState<ModelsListState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!bridge.modelsList) {
      setState({ status: "unavailable" });
      return;
    }
    bridge.modelsList().then(
      (catalog) => {
        if (!cancelled) setState({ status: "ready", models: catalog.models });
      },
      () => {
        if (!cancelled) setState({ status: "unavailable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  return state;
}
