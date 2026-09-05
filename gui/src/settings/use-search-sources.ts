/**
 * Assembles the Settings search index's `SearchSource[]` (#28, issue #19
 * story #19/#20) from every section: App Preferences' four static rows
 * (hardcoded to match `theme-row.tsx`/`omp-binary-row.tsx`/`working-
 * directory-row.tsx`/`chromium-path-row.tsx`'s own `rowKey`s — there is
 * no controller to read these from generically, they're one-off rows),
 * Models' three claimed-key rows (mirroring `claims.ts`'s
 * `CLAIMED_KEYS`, also static — the roles hit points at the first role
 * row (`model-role-smol`); the catalog hits point at the filter input's
 * own `models-filter` row, since `enabledModels`/`disabledProviders`
 * otherwise have no single row knowable ahead of a real `modelsList()`
 * response — every provider/model row is one per catalog entry),
 * Accounts' single section-level row, every generic omp settings-tab row
 * (`buildSchemaView`, the same derivation `schema-tab-section.tsx` uses,
 * so a hit's `rowKey` always resolves to that section's real
 * `id="row-<rowKey>"` anchor), and Advanced's schema-uiless keys (a
 * claimed uiless key is skipped here — it already has a dedicated Models
 * row above, and `advanced-section.tsx`'s pointer row would otherwise
 * search-duplicate the same key under two different destinations).
 *
 * Sections whose live data (schema, config entries) hasn't loaded yet
 * simply contribute nothing yet from (d)/(e) — the index recomputes as
 * `useConfigSchema`/`useSettings` resolve, exactly like every other
 * Settings consumer of those hooks.
 */
import { useMemo } from "react";
import {
  buildSchemaView,
  buildSearchIndex,
  type SearchSource,
  type SettingsController,
  type ShellBridge,
} from "@omp-gui/ipc";
import { CLAIMED_KEYS } from "@gui/components/settings/claims";
import { useSettings } from "./use-settings";
import { useConfigSchema } from "./use-config-schema";
import { detectPlatform } from "./platform";

const APP_PREFERENCES_SOURCES: SearchSource[] = [
  {
    section: "app-preferences",
    sectionLabel: "App Preferences",
    to: "/settings/app-preferences",
    group: "Appearance",
    rowKey: "theme",
    keyPath: "theme",
    label: "Theme",
    description: "System follows your OS's light/dark setting.",
  },
  {
    section: "app-preferences",
    sectionLabel: "App Preferences",
    to: "/settings/app-preferences",
    group: "omp binary",
    rowKey: "omp-binary",
    keyPath: "ompPath",
    label: "Which omp the app runs",
    description: "Point the app at your own omp binary instead of the bundled one.",
  },
  {
    section: "app-preferences",
    sectionLabel: "App Preferences",
    to: "/settings/app-preferences",
    group: "Sessions",
    rowKey: "default-working-directory",
    keyPath: "defaultWorkingDirectory",
    label: "Default working directory",
    description:
      "New sessions start here. Resumed sessions always keep their own recorded directory.",
  },
  {
    section: "app-preferences",
    sectionLabel: "App Preferences",
    to: "/settings/app-preferences",
    group: "Sessions",
    rowKey: "chromium-path",
    keyPath: "chromiumPath",
    label: "Chromium path",
    description:
      "Used by the Browser Pane. An environment variable override always wins over this.",
  },
];

const MODELS_SOURCES: SearchSource[] = [
  {
    section: "models",
    sectionLabel: "Models",
    to: "/settings/models",
    group: "Roles",
    rowKey: "model-role-smol",
    keyPath: "modelRoles",
    label: "Model roles",
    description: "Assign the smol, default and slow model roles from the catalog.",
  },
  {
    section: "models",
    sectionLabel: "Models",
    to: "/settings/models",
    group: "Catalog",
    rowKey: "models-filter",
    keyPath: "enabledModels",
    label: "Enabled models",
    description: "Which catalog models are available to pick from.",
  },
  {
    section: "models",
    sectionLabel: "Models",
    to: "/settings/models",
    group: "Catalog",
    rowKey: "models-filter",
    keyPath: "disabledProviders",
    label: "Disabled providers",
    description: "Providers hidden from the model catalog.",
  },
];

const ACCOUNTS_SOURCES: SearchSource[] = [
  {
    section: "accounts",
    sectionLabel: "Accounts",
    to: "/settings/accounts",
    rowKey: "accounts",
    label: "Accounts",
    description: "Provider logins — see who you're signed in as, log in or out.",
  },
];

export function useSearchSources(bridge: ShellBridge, settings: SettingsController) {
  const snapshot = useSettings(settings);
  const schemaState = useConfigSchema(bridge);
  const claimed = useMemo(() => new Set(Object.keys(CLAIMED_KEYS)), []);
  const env = useMemo(
    () => ({ platform: detectPlatform(), terminalCapabilities: new Set<string>() }),
    [],
  );

  return useMemo(() => {
    const sources: SearchSource[] = [
      ...APP_PREFERENCES_SOURCES,
      ...MODELS_SOURCES,
      ...ACCOUNTS_SOURCES,
    ];
    if (schemaState.status !== "ready") return buildSearchIndex(sources);

    const view = buildSchemaView(schemaState.schema, snapshot.entries, claimed, env);
    for (const tab of view.tabs) {
      const rows = tab.ungrouped
        .map((row) => ({ row, group: undefined as string | undefined }))
        .concat(
          tab.groups.flatMap((group) => group.rows.map((row) => ({ row, group: group.name }))),
        );
      for (const { row, group } of rows) {
        if (!row.visible) continue;
        sources.push({
          section: `tab:${tab.id}`,
          sectionLabel: tab.label,
          to: `/settings/${tab.id}`,
          group,
          rowKey: `tab.${row.entry.key}`,
          keyPath: row.entry.key,
          label: row.entry.label ?? row.entry.key,
          description: row.entry.description ?? undefined,
        });
      }
    }

    for (const key of view.uiless) {
      if (claimed.has(key)) continue;
      sources.push({
        section: "advanced",
        sectionLabel: "Advanced",
        to: "/settings/advanced",
        rowKey: `advanced.${key}`,
        keyPath: key,
        label: key,
        description: snapshot.entries.get(key)?.description,
      });
    }

    return buildSearchIndex(sources);
  }, [schemaState, snapshot.entries, claimed, env]);
}
