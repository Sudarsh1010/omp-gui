/**
 * Settings rail registry (T20, issue #19/#20). `STATIC_SECTIONS` holds the
 * sections shipped by this ticket; later tickets append their own entries
 * rather than editing this array in place — #25 (Accounts), #27 (Models)
 * append bespoke sections, #24 (Advanced) appends the catch-all, #26
 * supplies the dynamic omp-tab sections at runtime (threaded through
 * `SettingsLayout`'s `dynamicSections` prop, never baked in here since
 * they come from `omp config schema --json`).
 *
 * Rail order (ADR-0011 "Information architecture"): app → bespoke → omp
 * tabs (dynamic) → advanced.
 */
export type SectionId = "app-preferences" | "models" | "accounts" | `tab:${string}` | "advanced";

export interface SettingsSection {
  id: SectionId;
  label: string;
  to: string;
  /** Rail grouping — the coarse ordering `SettingsLayout` sorts by. */
  group: "app" | "bespoke" | "omp" | "advanced";
}

export const STATIC_SECTIONS: SettingsSection[] = [
  { id: "app-preferences", label: "App Preferences", to: "/settings/app-preferences", group: "app" },
  { id: "accounts", label: "Accounts", to: "/settings/accounts", group: "bespoke" },
  { id: "models", label: "Models", to: "/settings/models", group: "bespoke" },
  { id: "advanced", label: "Advanced", to: "/settings/advanced", group: "advanced" },
];
