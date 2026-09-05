import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "@gui/route-tree.gen";
import { QueryClient } from "@tanstack/react-query";
import {
  createAppPreferencesController,
  createIpcClient,
  createSessionsStore,
  DEFAULT_APP_PREFERENCES,
  tauriBridge,
} from "@omp-gui/ipc";
import { applyTheme } from "@gui/theme";

const queryClient = new QueryClient();
const bridge = tauriBridge();
const ipc = createIpcClient(bridge);
const sessionsStore = createSessionsStore(ipc);
const preferences = createAppPreferencesController(bridge);

// Apply the theme before first paint (issue #19 story #40: no flash of the
// wrong theme). `preferences`'s own async load races this — harmless, its
// first resolution just re-applies the same value — so this stays a
// separate, deliberately blocking read rather than waiting on the
// controller. `preferencesRead` is optional on `ShellBridge` (only
// `nodeBridge` omits it); the real Tauri shell always implements it.
const initialPrefs =
  (await bridge.preferencesRead?.().catch(() => undefined)) ?? DEFAULT_APP_PREFERENCES;
applyTheme(initialPrefs.theme ?? "system");

// Keep the theme live: a change from the Theme row (or a future external
// edit picked up by `reload()`) re-applies immediately.
preferences.subscribe(() => applyTheme(preferences.snapshot().prefs.theme ?? "system"));

const router = createRouter({
  routeTree,
  defaultStructuralSharing: true,
  context: { queryClient, sessionsStore, bridge, preferences },
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
