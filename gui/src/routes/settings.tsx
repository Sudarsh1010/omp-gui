import { useEffect, useMemo, useRef } from "react";
import { createFileRoute, Outlet, useNavigate, useRouteContext, useRouterState } from "@tanstack/react-router";
import { createSettingsController, type SettingsController, type SettingsStatus } from "@omp-gui/ipc";
import { SettingsLayout } from "@gui/components/settings/settings-layout";
import { SettingsProvider } from "@gui/components/settings/settings-context";
import { SettingsBanner } from "@gui/components/settings/settings-banner";
import { useSettings } from "@gui/settings/use-settings";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";

export const Route = createFileRoute("/settings")({
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
 */
function SettingsRouteContent({ settings }: { settings: SettingsController }) {
  const snapshot = useSettings(settings);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const useBundled = useBundledOmp();
  const prevStatus = useRef<SettingsStatus>(snapshot.status);

  useEffect(() => {
    const wasError = prevStatus.current === "error";
    prevStatus.current = snapshot.status;
    if (snapshot.status === "error" && !wasError && pathname !== APP_PREFERENCES_PATH) {
      void navigate({ to: APP_PREFERENCES_PATH, replace: true });
    }
  }, [snapshot.status, pathname, navigate]);

  const degraded = snapshot.status === "error" && pathname === APP_PREFERENCES_PATH;

  return (
    <SettingsLayout>
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
