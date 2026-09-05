/**
 * Registry of config keys a bespoke Settings section owns outright
 * (ADR-0011 "a key claimed by a bespoke section ... is excluded from
 * generic rendering and its Advanced row becomes a pointer to that
 * section, so no key ever has two editors"). Advanced (#24) renders a
 * pointer row ("Edited in <label> →") for every key here instead of a
 * generic editor; the schema-driven omp-tab renderer (#26) skips them the
 * same way. Sections append their own claimed keys here rather than
 * editing existing entries — #27 (Models) claims `modelRoles`/
 * `enabledModels`/`disabledProviders`; #29 (approval/fallback/limits)
 * appends its own.
 */
import type { SectionId } from "./sections";

export interface ClaimedKey {
  section: SectionId;
  label: string;
}

export const CLAIMED_KEYS: Record<string, ClaimedKey> = {
  modelRoles: { section: "models", label: "Models" },
  enabledModels: { section: "models", label: "Models" },
  disabledProviders: { section: "models", label: "Models" },
  // #29: rendered by a bespoke editor inside their own schema tab
  // (`schema-tab-section.tsx`'s `BESPOKE_EDITORS` registry), not fully
  // excluded from that tab's row list the way `models` above is — see
  // that file's `claimed` derivation. The Advanced pointer still uses
  // this same entry, resolving `tab:<id>` to `/settings/<id>`.
  "tools.approval": { section: "tab:interaction", label: "Interaction" },
  "retry.fallbackChains": { section: "tab:model", label: "Model" },
  "providers.maxInFlightRequests": { section: "tab:providers", label: "Providers" },
};
