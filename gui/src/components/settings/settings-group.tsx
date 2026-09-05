/**
 * A Settings section's row group (T20, issue #19/#20): a hairline card
 * (`ring-1 ring-foreground/10`, reused from `@omp-gui/ui`'s `Card`) with a
 * serif `font-heading` title and 32px `SettingsRow`s separated by
 * `divide-y` — the shared primitive every later Settings ticket's rows
 * render inside, never a bespoke card.
 */
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@omp-gui/ui/components/card";
import { cn } from "@omp-gui/ui/lib/utils";
import { useRowHighlight } from "@gui/settings/use-row-highlight";

export interface SettingsGroupProps {
  title: string;
  badge?: ReactNode;
  /** Makes the group header itself a search scroll-highlight target
   * (#28) — for a group with no single row that stands in for the whole
   * group (e.g. Accounts, whose rows are one per provider and can't be
   * named statically by the search index). Omit for groups already
   * covered by their own rows' `rowKey`s. */
  rowKey?: string;
  children: ReactNode;
}

export function SettingsGroup({ title, badge, rowKey, children }: SettingsGroupProps) {
  const pulsing = useRowHighlight(rowKey ?? "");
  return (
    <Card size="sm">
      <CardHeader
        data-settings-row={rowKey}
        id={rowKey ? `row-${rowKey}` : undefined}
        className={cn(
          "flex-row items-center justify-between gap-2 transition-colors duration-700",
          rowKey && pulsing && "bg-muted",
        )}
      >
        <CardTitle>{title}</CardTitle>
        {badge}
      </CardHeader>
      <CardContent className="px-0 divide-y divide-border">{children}</CardContent>
    </Card>
  );
}
