/**
 * The Settings content column while search is active (#28, issue #19
 * story #19/#20): replaces `settings-layout.tsx`'s `<Outlet/>` with
 * grouped hits — one hairline `SettingsGroup` card per `section › group`,
 * 32px rows showing label, a truncated one-line description and the
 * mono key path. Click navigates the same way Enter does in
 * `settings-search.tsx` (`settings-layout.tsx`'s `goToHit`): to the hit's
 * section with `?row=<rowKey>`, which `use-row-highlight.ts` scroll-
 * highlights on arrival.
 *
 * The empty state teaches the key-name form (issue #19 story #20) rather
 * than just saying "nothing found".
 */
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { SearchHit } from "@omp-gui/ipc";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@omp-gui/ui/components/empty";
import { Button } from "@omp-gui/ui/components/button";
import { SettingsGroup } from "./settings-group";

export interface SearchResultsProps {
  hits: SearchHit[];
  query: string;
  onNavigate: (hit: SearchHit) => void;
}

interface HitGroup {
  key: string;
  title: string;
  hits: SearchHit[];
}

function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  const byKey = new Map<string, HitGroup>();
  for (const hit of hits) {
    const key = `${hit.section}:${hit.group ?? ""}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, title: hit.group ? `${hit.sectionLabel} › ${hit.group}` : hit.sectionLabel, hits: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return groups;
}

export function SearchResults({ hits, query, onNavigate }: SearchResultsProps) {
  if (hits.length === 0) {
    return (
      <Empty className="ring-1 ring-foreground/10 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MagnifyingGlassIcon />
          </EmptyMedia>
          <EmptyTitle>No settings match "{query}"</EmptyTitle>
          <EmptyDescription>
            Try the key path, e.g. <span className="font-mono">retry.maxRetries</span>.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      {groupHits(hits).map((group) => (
        <SettingsGroup key={group.key} title={group.title}>
          {group.hits.map((hit) => (
            <Button
              key={hit.rowKey}
              variant="ghost"
              onClick={() => onNavigate(hit)}
              className="h-8 w-full min-w-0 justify-between gap-3 px-3 font-normal"
            >
              <span className="max-w-[45%] shrink-0 truncate text-xs font-medium text-foreground">{hit.label}</span>
              {hit.description && (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{hit.description}</span>
              )}
              {hit.keyPath && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{hit.keyPath}</span>
              )}
            </Button>
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}
