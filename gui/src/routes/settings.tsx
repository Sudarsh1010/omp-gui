import { useEffect, useMemo, useRef } from "react";
import { createFileRoute, Outlet, useNavigate, useRouteContext, useRouterState } from "@tanstack/react-router";
import { createSettingsController, type SettingsController, type SettingsStatus } from "@omp-gui/ipc";
import { SettingsLayout } from "@gui/components/settings/settings-layout";
import type { SettingsSection } from "@gui/components/settings/sections";
import { SettingsProvider, useSettingsContext } from "@gui/components/settings/settings-context";
import { SettingsBanner } from "@gui/components/settings/settings-banner";
import { useSettings } from "@gui/settings/use-settings";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";
import { useConfigSchema } from "@gui/settings/use-config-schema";

/** Loose `{ row?: string }` shape (#28, issue #19 "Search" — "navigation
 * scroll-highlights the row"): every Settings route inherits this since
 * TanStack Router merges a parent's validated search into its
 * descendants, so `navigate({ to: "/settings/<any tab>", search: { row }
 * })` typechecks from `settings-layout.tsx`'s `goToHit` regardless of
 * which section the hit targets, and `use-row-highlight.ts` can read it
 * from any row in any section via `useSearch({ strict: false })`. */
function validateSearch(search: Record<string, unknown>): { row?: string } {
  return { row: typeof search.row === "string" ? search.row : undefined };
}

export const Route = createFileRoute("/settings")({
  validateSearch,
  component: SettingsRoute,
});

const APP_PREFERENCES_PATH = "/settings/app-preferences";

function SettingsRoute() {
  const { bridge, preferences } = useRouteContext({ from: "__root__" });
  const settings = useMemo(() => createSettingsController(bridge), [bridge]);
  useEffect(() => settings.dispose, [settings]);

  return (
    <SettingsProvider value={{ bridge, preferences, settings }}>
      <SettingsRouteContent settings={settings} />
    </SettingsProvider>
  );
}

/**
 * Wraps `SettingsLayout`/`<Outlet/>` so it can read `settings`'s snapshot
 * (needs to be inside `SettingsProvider` for `useBundledOmp`, which reads
 * `useSettingsContext()`) and apply ADR-0011's "Bootstrap independence"
 * degraded rule: entering — or landing in — an error status navigates to
 * App Preferences with a banner naming the failure. The redirect fires
 * only on the transition into `"error"` (a `prevStatus` ref, not a bare
 * status check), so a user who manually navigates elsewhere while still
 * degraded is never bounced back — "do not loop".
 *
 * Also supplies the rail's dynamic omp-tab sections (#26, ADR-0011
 * "Information architecture"): one per `config schema --json` tab, in the
 * schema's own declared order, appended after the bespoke sections. An
 * override binary that predates `config schema` (`useConfigSchema`
 * resolving to `"unavailable"`) contributes none — the rail simply has no
 * omp tabs and Advanced (`advanced-section.tsx`) falls back to listing
 * every key, per ADR-0011's guaranteed degrade path.
 */
function SettingsRouteContent({ settings }: { settings: SettingsController }) {
  const { bridge } = useSettingsContext();
  const snapshot = useSettings(settings);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const useBundled = useBundledOmp();
  const prevStatus = useRef<SettingsStatus>(snapshot.status);
  const schemaState = useConfigSchema(bridge);

  const dynamicSections = useMemo((): SettingsSection[] => {
    if (schemaState.status !== "ready") return [];
    return schemaState.schema.tabs.map((tab) => ({
      id: `tab:${tab.id}` as const,
      label: tab.label,
      to: `/settings/${tab.id}`,
      group: "omp" as const,
    }));
  }, [schemaState]);

  useEffect(() => {
    const wasError = prevStatus.current === "error";
    prevStatus.current = snapshot.status;
    if (snapshot.status === "error" && !wasError && pathname !== APP_PREFERENCES_PATH) {
      void navigate({ to: APP_PREFERENCES_PATH, replace: true });
    }
  }, [snapshot.status, pathname, navigate]);

  const degraded = snapshot.status === "error" && pathname === APP_PREFERENCES_PATH;

  return (
    <SettingsLayout dynamicSections={dynamicSections}>
      {degraded && snapshot.error && (
        <SettingsBanner
          message={`${snapshot.error.stage}: ${snapshot.error.message}`}
          actions={[
            { label: "Use bundled omp", onClick: () => void useBundled() },
            { label: "Retry", onClick: () => void settings.reload() },
          ]}
        />
      )}
      <Outlet />
    </SettingsLayout>
  );
}
