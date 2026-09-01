import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { AppShell } from "@gui/components/app/app-shell";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { sessionsStore } = useRouteContext({ from: "__root__" });
  return <AppShell store={sessionsStore} />;
}
