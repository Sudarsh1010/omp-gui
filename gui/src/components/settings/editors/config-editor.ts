/**
 * Shared prop contract every Advanced-section editor (#24, issue #19)
 * implements. `onSet` fires the raw value straight at
 * `SettingsController.set` — the controller (not the editor) owns
 * pending/saved/rejected per-row state, so an editor never awaits it or
 * renders its own status text for a server rejection; `advanced-
 * section.tsx` derives each row's `SettingsRow status` from the
 * controller's `rows` map.
 */
import type { ConfigEntry } from "@omp-gui/ipc";

export interface ConfigEditorProps {
  entry: ConfigEntry;
  onSet: (value: unknown) => void;
}
