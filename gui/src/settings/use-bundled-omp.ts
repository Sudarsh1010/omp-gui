/**
 * Reverts the App Preferences omp override to the bundled pin (T23, issue
 * #19/#23, ADR-0004): "'Use bundled omp' restores the pin without a
 * dialog." Exposed as a hook (not inlined in `omp-binary-row.tsx`) so
 * `SectionError.onUseBundled` -- shipped by #20, wired here -- can pass
 * this exact handler from any degraded omp-backed section, not just the
 * App Preferences row itself: a broken committed override is what most
 * often causes that degradation in the first place.
 */
import { useCallback } from "react";
import { useSettingsContext } from "../components/settings/settings-context";

export function useBundledOmp(): () => Promise<void> {
  const { bridge, preferences } = useSettingsContext();

  return useCallback(async () => {
    await bridge.ompOverrideClear?.();
    await preferences.reload();
  }, [bridge, preferences]);
}
