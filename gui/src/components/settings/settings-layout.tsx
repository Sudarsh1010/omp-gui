/**
 * The Settings page shell (T20, issue #19/#20): a 200px left rail of 32px
 * rows, a 40px chrome bar (back, serif title, search field), and one
 * scrolling content column — `routes/settings.tsx` renders this around its
 * `<Outlet/>`. Back and `Esc` both return to `originHref()`
 * (`gui/src/settings/settings-origin.ts`), never `history.back()`, so the
 * gear/shortcut's `rememberOrigin` call is the single source of truth for
 * "where Settings was opened from".
 *
 * Search (#28, issue #19 story #19/#20) lives here too: ⌘F/Ctrl+F is
 * registered in this same keydown handler (alongside the pre-existing
 * Esc-back), and a non-empty query swaps the content column for
 * `SearchResults` instead of `children`. `event.defaultPrevented` guards
 * the Esc-back branch — `settings-search.tsx`'s own Esc handler
 * `preventDefault()`s a clearing Esc so it never also fires back
 * navigation, but leaves an already-empty field's Esc alone to fall
 * through here normally.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Button, buttonVariants } from "@omp-gui/ui/components/button";
import { cn } from "@omp-gui/ui/lib/utils";
import { searchSettings, type SearchHit } from "@omp-gui/ipc";
import { originHref } from "@gui/settings/settings-origin";
import { useSearchSources } from "@gui/settings/use-search-sources";
import { useSettingsContext } from "./settings-context";
import { SettingsSearch } from "./settings-search";
import { SearchResults } from "./search-results";
import { STATIC_SECTIONS, type SettingsSection } from "./sections";

export interface SettingsLayoutProps {
  /** Sections beyond `STATIC_SECTIONS` — the omp-tab sections #26 derives
   * live from `omp config schema --json`, and the bespoke/advanced
   * sections #24/#25/#27 append. Empty until those tickets land. */
  dynamicSections?: SettingsSection[];
  children: ReactNode;
}

/** Rail order (ADR-0011 "Information architecture"): App Preferences;
 * Models, Accounts; omp's tabs in schema order; Advanced. `group` is each
 * section's own coarse ordering key (`sections.ts`'s doc comment) — a
 * stable sort on it, not concatenation order, is what keeps the dynamic
 * omp tabs (`group: "omp"`) landing before the static `advanced` entry
 * regardless of which array either section came from. */
const GROUP_ORDER: Record<SettingsSection["group"], number> = { app: 0, bespoke: 1, omp: 2, advanced: 3 };

export function SettingsLayout({ dynamicSections = [], children }: SettingsLayoutProps) {
  const { bridge, settings } = useSettingsContext();
  if (!settings) {
    throw new Error("SettingsLayout requires routes/settings.tsx's SettingsController in context");
  }
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sections = [...STATIC_SECTIONS, ...dynamicSections].sort(
    (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group],
  );

  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const index = useSearchSources(bridge, settings);
  const hits = useMemo(() => searchSettings(index, query), [index, query]);

  const goBack = useCallback(() => {
    void navigate({ href: originHref() });
  }, [navigate]);

  const goToHit = useCallback(
    (hit: SearchHit) => {
      setQuery("");
      void navigate({ to: hit.to, search: { row: hit.rowKey } });
    },
    [navigate],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      goBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack]);

  const searching = query.trim().length > 0;

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="icon-sm" onClick={goBack} aria-label="Back">
          <ArrowLeftIcon />
        </Button>
        <h1 className="font-heading text-sm font-medium">Settings</h1>
        <SettingsSearch inputRef={searchInputRef} value={query} onChange={setQuery} hits={hits} onNavigate={goToHit} />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2">
          {sections.map((section) => {
            const active = pathname === section.to || pathname.startsWith(`${section.to}/`);
            return (
              <Link
                key={section.id}
                to={section.to}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-8 w-full justify-start px-2.5",
                  active && "bg-muted text-foreground",
                )}
              >
                {section.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
            {searching ? <SearchResults hits={hits} query={query} onNavigate={goToHit} /> : children}
          </div>
        </div>
      </div>
    </div>
  );
}
