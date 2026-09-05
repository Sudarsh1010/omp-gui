/**
 * Builds the schema-driven render model for #26's omp-tab sections (ADR-
 * 0011 §"schema/structure", contract §F) from `ConfigSchema` +
 * `configList()`'s entries — the pure, framework-agnostic half of
 * `schema-tab-section.tsx` so the tab/group/row derivation (ordering,
 * visibility, terminal-only marking, modified-from-default) is unit-
 * testable without React or a bridge. Rebuilding this from scratch on
 * every entries change is what makes toggling a parent setting show/hide
 * its dependents live (issue #19 story #18): there is no memoized
 * per-row subscription to invalidate, the whole view is just a function
 * of the latest `entries` snapshot.
 */
import type { ConfigEntry, ConfigSchema, SchemaEntry } from "../bindings/bindings.gen";
import { evaluateCondition, jsonValueEquals, type ConditionEnv } from "./conditions";

/** One schema-driven row: the schema's own description of the setting,
 * this render pass's resolved `ConfigEntry` (`undefined` only if the
 * schema names a key `configList()` didn't report — an override binary
 * whose schema drifted from its own `list`), and the three booleans
 * `schema-tab-section.tsx` needs to decide what to render. */
export interface SchemaRowView {
  entry: SchemaEntry;
  value: ConfigEntry | undefined;
  /** Whether `entry.condition` currently holds — a `false` row is not
   * rendered at all (issue #19 story #18), never rendered disabled. */
  visible: boolean;
  /** `tui.*`-prefixed key, or a `terminal`-kind condition — issue #19
   * story #15's "Terminal only" marking. `evaluateCondition` never hides
   * a terminal-conditioned row (visibility isn't the GUI's call to make),
   * so this flag is how the caller marks it instead — a "Terminal only"
   * badge beside the row, and on the group when every row in it is
   * terminal-only. */
  terminalOnly: boolean;
  /** `value.value` differs from `entry.default` (JSON-deep equality). */
  modified: boolean;
}

export interface SchemaGroupView {
  name: string;
  /** True when every row in the group is `terminalOnly` (issue #19 story
   * #15). A mixed group never carries the badge — only its terminal rows
   * do (rendered per-row by the caller if desired). */
  terminalOnly: boolean;
  rows: SchemaRowView[];
}

export interface SchemaTabView {
  id: string;
  label: string;
  /** In `SchemaTab.groups` order — omp's own group ordering, per issue
   * #19's "omp's own tabs, groups and labels" requirement. Empty groups
   * (declared in the tab but with no matching settings) are omitted. */
  groups: SchemaGroupView[];
  /** Rows whose `group` is absent, or names a group the tab never
   * declared (`TAB_GROUPS`) — rendered at the top of the tab, ungrouped. */
  ungrouped: SchemaRowView[];
}

export interface SchemaView {
  tabs: SchemaTabView[];
  /** Keys `SchemaEntry.tab` never names (issue #19 story #16: "settings
   * omp's own panel hides ... collected under Advanced"). Independent of
   * `claimed` — a claimed uiless key (e.g. `enabledModels`) still belongs
   * here; `advanced-section.tsx` decides pointer-vs-editor per key itself. */
  uiless: string[];
}

function toRowView(
  entry: SchemaEntry,
  entries: ReadonlyMap<string, ConfigEntry>,
  env: ConditionEnv,
): SchemaRowView {
  const value = entries.get(entry.key);
  return {
    entry,
    value,
    visible: evaluateCondition(entry.condition, entries, env),
    terminalOnly: entry.key.startsWith("tui.") || entry.condition?.kind === "terminal",
    modified: value !== undefined && !jsonValueEquals(value.value, entry.default),
  };
}

export function buildSchemaView(
  schema: ConfigSchema,
  entries: ReadonlyMap<string, ConfigEntry>,
  claimed: ReadonlySet<string>,
  env: ConditionEnv,
): SchemaView {
  const uiless: string[] = [];
  const byTab = new Map<string, SchemaEntry[]>();

  for (const entry of schema.settings) {
    if (!entry.tab) {
      uiless.push(entry.key);
      continue;
    }
    if (claimed.has(entry.key)) continue;
    const bucket = byTab.get(entry.tab);
    if (bucket) bucket.push(entry);
    else byTab.set(entry.tab, [entry]);
  }

  const tabs = schema.tabs.map((tab): SchemaTabView => {
    const tabEntries = byTab.get(tab.id) ?? [];
    const declaredGroups = new Set(tab.groups);
    const byGroup = new Map<string, SchemaEntry[]>();
    const ungroupedEntries: SchemaEntry[] = [];

    for (const entry of tabEntries) {
      if (entry.group && declaredGroups.has(entry.group)) {
        const bucket = byGroup.get(entry.group);
        if (bucket) bucket.push(entry);
        else byGroup.set(entry.group, [entry]);
      } else {
        // No group, or a group string the tab never declared in
        // `TAB_GROUPS` — renders ungrouped at the top (05-omp-settings-
        // schema.md §2's documented fallback).
        ungroupedEntries.push(entry);
      }
    }

    const groups: SchemaGroupView[] = [];
    for (const name of tab.groups) {
      const groupEntries = byGroup.get(name);
      if (!groupEntries || groupEntries.length === 0) continue;
      const rows = groupEntries.map((entry) => toRowView(entry, entries, env));
      groups.push({ name, terminalOnly: rows.every((row) => row.terminalOnly), rows });
    }

    return {
      id: tab.id,
      label: tab.label,
      groups,
      ungrouped: ungroupedEntries.map((entry) => toRowView(entry, entries, env)),
    };
  });

  return { tabs, uiless };
}
