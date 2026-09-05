/**
 * Where Settings was opened from (T20, issue #19 story #3). The gear
 * button/shortcut (`session-sidebar.tsx`, `app-shell.tsx`) calls
 * `rememberOrigin(location.href)` immediately before navigating to
 * `/settings`; the settings layout's back button and `Esc` handler call
 * `originHref()` to return there. A plain module-scoped variable, not
 * persisted — Settings only ever opens from within the same running app
 * instance, so there is nothing to restore across a relaunch.
 */
let origin: string | undefined;

export function rememberOrigin(href: string): void {
  origin = href;
}

export function originHref(): string {
  return origin ?? "/";
}
