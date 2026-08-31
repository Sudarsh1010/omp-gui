import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import appCss from "@omp-gui/ui/globals.css?url";
import { TooltipProvider } from "@omp-gui/ui/components/tooltip";
import type { QueryClient } from '@tanstack/react-query'


export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  head: () => ({
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootDocument
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
  )
}
