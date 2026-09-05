import { createFileRoute } from "@tanstack/react-router";
import { AdvancedSection } from "@gui/components/settings/advanced-section";

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedSection,
});
