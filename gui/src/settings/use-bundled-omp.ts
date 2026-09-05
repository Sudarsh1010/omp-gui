/**
 * Reverts the App Preferences omp override to the bundled pin (T23, issue
 * #19/#23, ADR-0004): "'Use bundled omp' restores the pin without a
 * dialog." Exposed as a hook (not inlined in `omp-binary-row.tsx`) so
 * `SectionError.onUseBundled` -- shipped by #20, wired here -- can pass
 * this exact handler from any degraded omp-backed section, not just the
 * App Preferences row itself: a broken committed override is what most
 * often causes that degradation in the first place. After the revert every
 * omp-backed source re-reads against the binary that now resolves: the
 * preferences snapshot, the settings controller (clears the degraded
 * banner), and the cached schema (brings omp's tabs back into the rail).
 */
import { useCallback } from "react";
import { useSettingsContext } from "../components/settings/settings-context";
import { invalidateConfigSchema } from "./use-config-schema";

export function useBundledOmp(): () => Promise<void> {
  const { bridge, preferences, settings } = useSettingsContext();

  return useCallback(async () => {
    await bridge.ompOverrideClear?.();
    await preferences.reload();
    invalidateConfigSchema();
    await settings?.reload();
  }, [bridge, preferences, settings]);
}
