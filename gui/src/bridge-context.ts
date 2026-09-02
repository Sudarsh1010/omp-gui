/**
 * Reads the app's single `tauriBridge` instance out of the root route's
 * typed context (constructed once in `main.tsx`, carried on `Route`'s
 * context in `routes/__root.tsx`). Call sites that used to construct their
 * own module-scoped bridge (`BrowserPane`, `RelayToggle`,
 * `useSessionDirectory`) call this instead, so the whole app shares one
 * bridge and a route can be rendered against a stub bridge outside a
 * running Tauri shell.
 */
import { useRouteContext } from "@tanstack/react-router";
import type { BrowserShellBridge } from "@omp-gui/ipc";

export function useBridge(): BrowserShellBridge {
  return useRouteContext({ from: "__root__" }).bridge;
}
