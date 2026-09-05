/**
 * Scroll-and-pulse highlight for one Settings row (#28, issue #19
 * "Search": "navigation scroll-highlights the row"). `settings-row.tsx`
 * calls this unconditionally for every row it renders — cheap when
 * `rowKey` doesn't match the `row` search param every Settings route
 * validates loosely (`routes/settings.tsx`'s `validateSearch`), so no
 * section needs its own second highlight mechanism.
 *
 * Reads `row` via `useSearch({ strict: false })` rather than a specific
 * route id, since the same hook runs from every section's rows. On a
 * match it scrolls the row's own `id="row-<rowKey>"` element (rendered
 * by `settings-row.tsx` itself) into view, holds a returned `pulsing`
 * flag true for one Stone Mist wash, then clears the `row` param so
 * revisiting the same URL — or a second search hit landing on the same
 * row — can re-trigger it.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

const PULSE_MS = 900;

export function useRowHighlight(rowKey: string): boolean {
  const rowParam = useSearch({
    strict: false,
    select: (search) => {
      const value = (search as Record<string, unknown>).row;
      return typeof value === "string" ? value : undefined;
    },
  });
  const navigate = useNavigate();
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (rowParam !== rowKey) return;
    document.getElementById(`row-${rowKey}`)?.scrollIntoView({ block: "center" });
    setPulsing(true);
    const timeout = window.setTimeout(() => setPulsing(false), PULSE_MS);
    // `to: "."` keeps the current section: a `from`-anchored navigate with
    // only `search` would target `/settings` itself, whose index route
    // bounces to App Preferences.
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, row: undefined }),
      replace: true,
    });
    return () => window.clearTimeout(timeout);
  }, [rowParam, rowKey, navigate]);

  return pulsing;
}
