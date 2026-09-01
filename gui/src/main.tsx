import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "@gui/route-tree.gen";
import { QueryClient } from "@tanstack/react-query";
import { createIpcClient, tauriBridge } from "@omp-gui/ipc";

const queryClient = new QueryClient();
const ipc = createIpcClient(tauriBridge());

const router = createRouter({
  routeTree,
  defaultStructuralSharing: true,
  context: { queryClient, ipc },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
