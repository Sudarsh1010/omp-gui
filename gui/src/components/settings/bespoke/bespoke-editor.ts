/**
 * Shared prop contract every bespoke schema-tab editor (#29, issue #19;
 * ADR-0011 "a key claimed by a bespoke section ... is excluded from
 * generic rendering") implements — the exact shape `schema-tab-section
 * .tsx`'s `BESPOKE_EDITORS` registry renders in place of the generic
 * per-type editor for a claimed key. Unlike `ConfigEditorProps`
 * (`editors/config-editor.ts`), there is no `onSet`: a bespoke editor
 * writes its own record shape (per-tool policy, ordered chains,
 * provider limits) through `SettingsController.set` directly via
 * `useSettingsContext()`, since no single generic "next value" callback
 * fits three different record algebras.
 */
import type { ConfigEntry, SchemaEntry } from "@omp-gui/ipc";

export interface BespokeEditorProps {
  entry: SchemaEntry;
  value: ConfigEntry | undefined;
}
