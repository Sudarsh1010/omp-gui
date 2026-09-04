/**
 * The Settings page shell (T20, issue #19/#20): a 200px left rail of 32px
 * rows, a 40px chrome bar (back, serif title, search slot), and one
 * scrolling content column — `routes/settings.tsx` renders this around its
 * `<Outlet/>`. Back and `Esc` both return to `originHref()`
 * (`gui/src/settings/settings-origin.ts`), never `history.back()`, so the
 * gear/shortcut's `rememberOrigin` call is the single source of truth for
 * "where Settings was opened from".
 */
import { useCallback, useEffect, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Button, buttonVariants } from "@omp-gui/ui/components/button";
import { Input } from "@omp-gui/ui/components/input";
import { cn } from "@omp-gui/ui/lib/utils";
import { originHref } from "@gui/settings/settings-origin";
import { STATIC_SECTIONS, type SettingsSection } from "./sections";

export interface SettingsLayoutProps {
  /** Sections beyond `STATIC_SECTIONS` — the omp-tab sections #26 derives
   * live from `omp config schema --json`, and the bespoke/advanced
   * sections #24/#25/#27 append. Empty until those tickets land. */
  dynamicSections?: SettingsSection[];
  children: ReactNode;
}

export function SettingsLayout({ dynamicSections = [], children }: SettingsLayoutProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sections = [...STATIC_SECTIONS, ...dynamicSections];

  const goBack = useCallback(() => {
    void navigate({ href: originHref() });
  }, [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      goBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack]);

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="icon-sm" onClick={goBack} aria-label="Back">
          <ArrowLeftIcon />
        </Button>
        <h1 className="font-heading text-sm font-medium">Settings</h1>
        <Input disabled placeholder="Search settings…" className="ml-auto h-7 w-56" />
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
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
