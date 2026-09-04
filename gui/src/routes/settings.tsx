import { createFileRoute, Outlet, useRouteContext } from "@tanstack/react-router";
import { SettingsLayout } from "@gui/components/settings/settings-layout";
import { SettingsProvider } from "@gui/components/settings/settings-context";

export const Route = createFileRoute("/settings")({
  component: SettingsRoute,
});

function SettingsRoute() {
  const { bridge, preferences } = useRouteContext({ from: "__root__" });
  return (
    <SettingsProvider value={{ bridge, preferences }}>
      <SettingsLayout>
        <Outlet />
      </SettingsLayout>
    </SettingsProvider>
  );
}
