/**
 * Registry of config keys claimed by a bespoke Settings section (ADR-0011
 * "A key claimed by a bespoke section... is excluded from generic
 * rendering and its Advanced row becomes a pointer to that section, so no
 * key ever has two editors"). The Advanced section (#24) renders a
 * claimed key as a pointer row — "Edited in <label>" plus a `Link` to
 * `section` — instead of a generic editor; #26's schema-tab rendering
 * skips claimed keys outright.
 *
 * #24 ships this empty; #27 (Models) appends `enabledModels`,
 * `disabledProviders`, `modelRoles`; #29 appends the approval,
 * fallback-chain and provider-limit keys. Appended to, never restructured
 * — every ticket adds its own entries below the last.
 */
import type { SectionId } from "./sections";

export interface ClaimedKey {
  section: SectionId;
  label: string;
}

export const CLAIMED_KEYS: Record<string, ClaimedKey> = {};
