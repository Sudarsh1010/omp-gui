/**
 * One omp settings tab (#26, issue #19), addressed by its schema id
 * (`appearance`, `model`, …) — deep-linkable per ADR-0011's "Nested routes
 * under one settings route, one per section, deep-linkable". An id the
 * schema doesn't declare (or a schema-less override binary) renders
 * `SectionError` from inside `SchemaTabSection` rather than a router 404,
 * since only the schema — loaded at render time, not route-load time —
 * knows which ids are valid.
 */
import { createFileRoute } from "@tanstack/react-router";
import { SchemaTabSection } from "@gui/components/settings/schema-tab-section";

export const Route = createFileRoute("/settings/$tab")({
  component: SchemaTabRoute,
});

function SchemaTabRoute() {
  const { tab } = Route.useParams();
  return <SchemaTabSection tabId={tab} />;
}
