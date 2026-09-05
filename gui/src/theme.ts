/**
 * Applies the App Preferences theme to the document root (T20, issue #20;
 * ADR-0011). Toggles `.dark` on `<html>`, matching
 * `platform/ui/src/styles/globals.css`'s `@custom-variant dark
 * (&:is(.dark *))` — every `dark:` utility across `@omp-gui/ui` activates
 * from that one class.
 *
 * `"system"` subscribes to `prefers-color-scheme` and keeps following it
 * live until the next `applyTheme` call replaces the subscription — only
 * one is ever active at a time, so switching from System to Light/Dark (or
 * back) never leaves a stale listener behind.
 */
import type { Theme } from "@omp-gui/ipc";

let unsubscribeSystem: (() => void) | undefined;

export function applyTheme(theme: Theme): void {
  unsubscribeSystem?.();
  unsubscribeSystem = undefined;

  if (theme === "system") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    document.documentElement.classList.toggle("dark", media.matches);
    const onChange = (event: MediaQueryListEvent) => {
      document.documentElement.classList.toggle("dark", event.matches);
    };
    media.addEventListener("change", onChange);
    unsubscribeSystem = () => media.removeEventListener("change", onChange);
    return;
  }

  document.documentElement.classList.toggle("dark", theme === "dark");
}
