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
};
