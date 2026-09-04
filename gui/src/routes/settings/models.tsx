import { useEffect, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createSettingsController } from "@omp-gui/ipc";
import { ModelsSection } from "@gui/components/settings/models-section";
import { useSettingsContext } from "@gui/components/settings/settings-context";

export const Route = createFileRoute("/settings/models")({
  component: ModelsRoute,
});

function ModelsRoute() {
  const { bridge, settings: sharedSettings } = useSettingsContext();
  // `settings-context.tsx`'s `settings` field is populated by #24's
  // `routes/settings.tsx` wiring; until that lands, fall back to a
  // locally owned `SettingsController` so this route never depends on
  // merge order (per the ticket's coordination note).
  const localSettings = useMemo(
    () => (sharedSettings ? undefined : createSettingsController(bridge)),
    [bridge, sharedSettings],
  );
  useEffect(() => () => localSettings?.dispose(), [localSettings]);

  const settings = sharedSettings ?? localSettings!;

  return <ModelsSection bridge={bridge} settings={settings} />;
}
