/**
 * A Settings section's row group (T20, issue #19/#20): a hairline card
 * (`ring-1 ring-foreground/10`, reused from `@omp-gui/ui`'s `Card`) with a
 * serif `font-heading` title and 32px `SettingsRow`s separated by
 * `divide-y` — the shared primitive every later Settings ticket's rows
 * render inside, never a bespoke card.
 */
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@omp-gui/ui/components/card";

export interface SettingsGroupProps {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}

export function SettingsGroup({ title, badge, children }: SettingsGroupProps) {
  return (
    <Card size="sm">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {badge}
      </CardHeader>
      <CardContent className="px-0 divide-y divide-border">{children}</CardContent>
    </Card>
  );
}
