/**
 * Boolean Advanced-section editor (#24, issue #19): a discrete control —
 * writes on change, per the Settings save model, never on blur.
 */
import { Switch } from "@omp-gui/ui/components/switch";
import type { ConfigEditorProps } from "./config-editor";

export function SwitchEditor({ entry, onSet }: ConfigEditorProps) {
  return <Switch checked={entry.value === true} onCheckedChange={(checked) => onSet(checked)} />;
}
