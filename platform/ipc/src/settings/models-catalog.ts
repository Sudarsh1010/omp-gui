/**
 * Models section controller (#27, issue #19/#27; ADR-0011 "Bespoke
 * sections"): a framework-agnostic snapshot/subscribe/dispose wrapper
 * joining the Shell Bridge's `modelsList()` (the read-only catalog
 * `omp models --json` reports, flat and ungrouped) with the config
 * bridge's own `enabledModels`/`disabledProviders`/`modelRoles` keys,
 * written through the shared `SettingsController` passed in — never a
 * second config path (ADR-0011 "no key ever has two editors"). Filter is
 * client-side, in-memory, over provider id and model id/name/selector
 * (issue #19 story #23).
 *
 * `enabledModels`'s empty-array semantics are omp's own, not assumed —
 * `ENABLED_MODELS_EMPTY_MEANS_ALL` documents the exact source
 * (`resolveAllowedModels` in the pinned package's `model-resolver.ts`,
 * captured verbatim in `04-omp-cli-surface.md` §12): "Returns the
 * unfiltered available list when `enabledModels` is empty." An empty
 * array means "no restriction — every model enabled", never "no models
 * enabled"; disabling one model from that all-enabled state has to
 * materialize the full catalog's selectors minus that one, since omp has
 * no separate "exclude" list.
 */
import type { ModelEntry, ShellBridge } from "../bridge/shell-bridge";
import type { JsonValue } from "../bindings/bindings.gen";
import type { SettingsController } from "./settings-controller";
import { describeCliError } from "./cli-error";

/**
 * omp's own documented semantics for the `enabledModels` allow-list
 * (pinned package's `model-resolver.ts`, `resolveAllowedModels`'s doc
 * comment, quoted in `04-omp-cli-surface.md` §12) — kept here as a named
 * constant so every call site that branches on "is this list empty" reads
 * as citing that source, not assuming the convention independently.
 */
export const ENABLED_MODELS_EMPTY_MEANS_ALL = true;

export type ModelsCatalogStatus = "loading" | "ready" | "error";

export interface CatalogModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogModelRow {
  id: string;
  /** `"<provider>/<id>"` — the value written into `enabledModels`/
   * `modelRoles`. */
  selector: string;
  name: string;
  enabled: boolean;
  contextWindow?: number;
  cost?: CatalogModelCost;
}

export interface CatalogProviderRow {
  id: string;
  /** omp's catalog carries no separate per-provider display name — this
   * is the provider id, kept as its own field so a future name source can
   * populate it without a shape change. */
  name: string;
  enabled: boolean;
  models: CatalogModelRow[];
}

export type ModelRole = "smol" | "default" | "slow";

export type ModelRoleAssignment = Record<ModelRole, string | undefined>;

export interface ModelsCatalogSnapshot {
  status: ModelsCatalogStatus;
  providers: CatalogProviderRow[];
  roles: ModelRoleAssignment;
  filter: string;
  error?: { stage: string; message: string };
}

export const EMPTY_MODELS_CATALOG_SNAPSHOT: ModelsCatalogSnapshot = {
  status: "loading",
  providers: [],
  roles: { smol: undefined, default: undefined, slow: undefined },
  filter: "",
  error: undefined,
};

export interface ModelsCatalogController {
  snapshot(): ModelsCatalogSnapshot;
  /** Register for snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-read the model catalog from omp, replacing the snapshot. Enable/
   * role state re-derives automatically from the shared `SettingsController`
   * passed to the constructor; reload that controller separately (the GUI
   * route already does, on entry and window focus) to refresh it too. */
  reload(): Promise<void>;
  /** Narrow `providers`/their `models` by a case-insensitive substring
   * match against provider id or model id/name/selector. */
  setFilter(text: string): void;
  /** Enables or disables a provider by writing `disabledProviders`. */
  setProviderEnabled(providerId: string, enabled: boolean): Promise<void>;
  /** Enables or disables one model by writing `enabledModels`, honoring
   * the empty-allow-list-means-all-enabled semantics documented on
   * `ENABLED_MODELS_EMPTY_MEANS_ALL`. */
  setModelEnabled(selector: string, enabled: boolean): Promise<void>;
  /** Assigns `modelSelector` to `role` by writing `modelRoles`. */
  setRole(role: ModelRole, modelSelector: string): Promise<void>;
  dispose(): void;
}

function modelsBridge(bridge: ShellBridge): Required<Pick<ShellBridge, "modelsList">> {
  if (!bridge.modelsList) {
    throw new Error("this ShellBridge does not implement Models");
  }
  return { modelsList: bridge.modelsList };
}

function asStringArray(value: JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asStringRecord(value: JsonValue | null | undefined): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

/** Groups `models` by provider, narrows by `filter` (a provider whose id
 * matches keeps every one of its models; otherwise only models whose own
 * id/name/selector match survive), and joins enable state. Providers left
 * with zero matching models after filtering are dropped entirely. */
function buildProviders(
  models: readonly ModelEntry[],
  enabledModels: readonly string[],
  disabledProviders: ReadonlySet<string>,
  filter: string,
): CatalogProviderRow[] {
  const byProvider = new Map<string, ModelEntry[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider);
    if (list) {
      list.push(model);
    } else {
      byProvider.set(model.provider, [model]);
    }
  }

  const needle = filter.trim().toLowerCase();

  const rows: CatalogProviderRow[] = [];
  for (const [providerId, providerModels] of byProvider) {
    const providerMatches = needle === "" || providerId.toLowerCase().includes(needle);
    const matchingModels = providerMatches
      ? providerModels
      : providerModels.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) ||
            model.name.toLowerCase().includes(needle) ||
            model.selector.toLowerCase().includes(needle),
        );
    if (matchingModels.length === 0) continue;

    rows.push({
      id: providerId,
      name: providerId,
      enabled: !disabledProviders.has(providerId),
      models: matchingModels
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((model) => ({
          id: model.id,
          selector: model.selector,
          name: model.name,
          // ENABLED_MODELS_EMPTY_MEANS_ALL
          enabled: enabledModels.length === 0 || enabledModels.includes(model.selector),
          // `f64` struct fields round-trip through specta-typescript as
          // `number | null` (its float-safety typing for NaN/Infinity,
          // not a real omp behavior — `omp models --json` always reports
          // finite numbers here); normalize to this shape's `undefined`/
          // `0` so a consumer never has to special-case `null`.
          contextWindow: model.contextWindow ?? undefined,
          cost: {
            input: model.cost.input ?? 0,
            output: model.cost.output ?? 0,
            cacheRead: model.cost.cacheRead ?? 0,
            cacheWrite: model.cost.cacheWrite ?? 0,
          },
        })),
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/**
 * Creates a `ModelsCatalogController` bound to one `ShellBridge` and the
 * `settings` controller the config bridge (`enabledModels`/
 * `disabledProviders`/`modelRoles`) rides on. Fetches the model catalog
 * immediately; call `dispose()` once the owning Settings route unmounts.
 */
export function createModelsCatalogController(
  bridge: ShellBridge,
  settings: SettingsController,
): ModelsCatalogController {
  let catalogModels: readonly ModelEntry[] = [];
  let catalogStatus: ModelsCatalogStatus = "loading";
  let catalogError: { stage: string; message: string } | undefined;
  let filter = "";
  let snapshot: ModelsCatalogSnapshot = EMPTY_MODELS_CATALOG_SNAPSHOT;
  const listeners = new Set<() => void>();

  const rebuild = () => {
    const settingsSnapshot = settings.snapshot();
    const enabledModels = asStringArray(settingsSnapshot.entries.get("enabledModels")?.value);
    const disabledProviders = new Set(
      asStringArray(settingsSnapshot.entries.get("disabledProviders")?.value),
    );
    const modelRoles = asStringRecord(settingsSnapshot.entries.get("modelRoles")?.value);

    const status: ModelsCatalogStatus =
      catalogStatus === "error" || settingsSnapshot.status === "error"
        ? "error"
        : catalogStatus === "loading" || settingsSnapshot.status === "loading"
          ? "loading"
          : "ready";

    snapshot = {
      status,
      providers: buildProviders(catalogModels, enabledModels, disabledProviders, filter),
      roles: {
        smol: modelRoles.smol,
        default: modelRoles.default,
        slow: modelRoles.slow,
      },
      filter,
      error: catalogError ?? settingsSnapshot.error,
    };
    for (const listener of listeners) listener();
  };

  const reload = async () => {
    try {
      const catalog = await modelsBridge(bridge).modelsList();
      catalogModels = catalog.models;
      catalogStatus = "ready";
      catalogError = undefined;
    } catch (error) {
      catalogStatus = "error";
      catalogError = describeCliError(error);
    }
    rebuild();
  };

  const unsubscribeSettings = settings.subscribe(rebuild);

  void reload();

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload,
    setFilter(text) {
      filter = text;
      rebuild();
    },
    async setProviderEnabled(providerId, enabled) {
      const current = new Set(
        asStringArray(settings.snapshot().entries.get("disabledProviders")?.value),
      );
      if (enabled) {
        current.delete(providerId);
      } else {
        current.add(providerId);
      }
      await settings.set("disabledProviders", Array.from(current));
    },
    async setModelEnabled(selector, enabled) {
      const enabledModels = asStringArray(settings.snapshot().entries.get("enabledModels")?.value);
      if (enabled) {
        if (enabledModels.length === 0 || enabledModels.includes(selector)) return;
        await settings.set("enabledModels", [...enabledModels, selector]);
        return;
      }
      if (enabledModels.length === 0) {
        // ENABLED_MODELS_EMPTY_MEANS_ALL: omp has no "exclude" list, only
        // an allow list — disabling one model from the all-enabled state
        // must materialize the full catalog's selectors minus this one.
        const allSelectors = catalogModels.map((model) => model.selector);
        await settings.set(
          "enabledModels",
          allSelectors.filter((current) => current !== selector),
        );
        return;
      }
      await settings.set(
        "enabledModels",
        enabledModels.filter((current) => current !== selector),
      );
    },
    async setRole(role, modelSelector) {
      const current = asStringRecord(settings.snapshot().entries.get("modelRoles")?.value);
      await settings.set("modelRoles", { ...current, [role]: modelSelector });
    },
    dispose() {
      unsubscribeSettings();
      listeners.clear();
    },
  };
}
