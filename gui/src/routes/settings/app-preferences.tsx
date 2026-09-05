import { createFileRoute } from "@tanstack/react-router";
import { AppPreferencesSection } from "@gui/components/settings/app-preferences-section";

export const Route = createFileRoute("/settings/app-preferences")({
  component: AppPreferencesSection,
});
