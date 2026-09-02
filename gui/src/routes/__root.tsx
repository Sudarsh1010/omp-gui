import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import appCss from "@omp-gui/ui/globals.css?url";
import { TooltipProvider } from "@omp-gui/ui/components/tooltip";
import type { QueryClient } from "@tanstack/react-query";
import type { BrowserShellBridge, SessionsStore } from "@omp-gui/ipc";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  sessionsStore: SessionsStore;
  bridge: BrowserShellBridge;
}>()({
  head: () => ({
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <>
      <HeadContent />
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
      <Scripts />
    </>
  );
}
