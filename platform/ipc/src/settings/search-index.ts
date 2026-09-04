/**
 * Pure client-side search over every Settings row (#28, issue #19 story
 * #19/#20; ADR-0011 §"Search": "Client-side over key, label and
 * description across all sections; results grouped section › group ›
 * row; navigation scroll-highlights the row"). No fuzzy engine, no
 * external search dependency — a simple case-insensitive substring/token
 * match, ranked so a key-path hit always outranks a label hit, which
 * always outranks a description-only hit.
 *
 * `buildSearchIndex`/`searchSettings` know nothing about React, routers,
 * or the bridge: `gui/src/settings/use-search-sources.ts` assembles the
 * `SearchSource[]` from every section (App Preferences' static rows,
 * Models' and Accounts' bespoke rows, the schema-driven omp tabs via
 * `buildSchemaView`, Advanced's uiless keys) and `settings-search.tsx` /
 * `search-results.tsx` are the only consumers of the result.
 */

/** One searchable row, contributed by a Settings section. `section` is a
 * `SectionId`-shaped string (`"models"`, `` `tab:${string}` ``, …) kept
 * as a plain string here so this module never depends on the GUI's
 * `SectionId` type; `to` is the route to navigate to and `rowKey` is the
 * same key `SettingsRow` renders as `id="row-<rowKey>"`, so a hit always
 * resolves to a real scroll-highlight anchor. */
export interface SearchSource {
  section: string;
  sectionLabel: string;
  to: string;
  group?: string;
  rowKey: string;
  keyPath?: string;
  label: string;
  description?: string;
}

/** A matched row — identical shape to `SearchSource`; a hit carries
 * nothing beyond what a `SearchSource` already has (no match spans, no
 * hidden score), so callers group and render hits exactly like sources. */
export type SearchHit = SearchSource;

export interface SearchIndex {
  readonly sources: readonly SearchSource[];
}

export function buildSearchIndex(sources: SearchSource[]): SearchIndex {
  return { sources: [...sources] };
}

/** Rank tiers, lowest wins: an exact key-path prefix beats any other
 * key-path match, which beats a label match, which beats a
 * description-only match; a query whose tokens are scattered across more
 * than one field (e.g. one word in the label, another in the
 * description) still matches but ranks last. */
const RANK_KEY_PATH_PREFIX = 0;
const RANK_KEY_PATH = 1;
const RANK_LABEL = 2;
const RANK_DESCRIPTION = 3;
const RANK_SCATTERED = 4;

export function searchSettings(index: SearchIndex, query: string): SearchHit[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  const fullQuery = tokens.join(" ");

  const scored: Array<{ source: SearchSource; rank: number }> = [];
  for (const source of index.sources) {
    const keyPath = source.keyPath?.toLowerCase();
    const label = source.label.toLowerCase();
    const description = source.description?.toLowerCase();
    const haystack = [keyPath, label, description].filter((field) => field !== undefined).join(" ");

    if (!tokens.every((token) => haystack.includes(token))) continue;

    let rank: number;
    if (keyPath && keyPath.startsWith(fullQuery)) rank = RANK_KEY_PATH_PREFIX;
    else if (keyPath && keyPath.includes(fullQuery)) rank = RANK_KEY_PATH;
    else if (label.includes(fullQuery)) rank = RANK_LABEL;
    else if (description && description.includes(fullQuery)) rank = RANK_DESCRIPTION;
    else rank = RANK_SCATTERED;

    scored.push({ source, rank });
  }

  scored.sort((a, b) => a.rank - b.rank || a.source.label.localeCompare(b.source.label));
  return scored.map((entry) => entry.source);
}
