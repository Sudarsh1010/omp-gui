import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { AccountsSection } from "@gui/components/settings/accounts-section";

export const Route = createFileRoute("/settings/accounts")({
  component: AccountsRoute,
});

function AccountsRoute() {
  const { sessionsStore } = useRouteContext({ from: "__root__" });
  return <AccountsSection store={sessionsStore} />;
}
