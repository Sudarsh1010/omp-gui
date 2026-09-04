/**
 * Enum Advanced-section editor (#24, issue #19): a discrete control that
 * writes on change. `values` comes from `SchemaEntry.values`
 * (`config list --json` never carries enum choices — the schema is the
 * only source, see `bindings.gen.ts`'s `SchemaEntry` doc comment);
 * `advanced-section.tsx` only renders this editor once the schema has
 * resolved and named this key's choices, falling back to `TextEditor`
 * otherwise.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@omp-gui/ui/components/select";
import type { ConfigEditorProps } from "./config-editor";

export interface SelectEditorProps extends ConfigEditorProps {
  values: string[];
}

export function SelectEditor({ entry, values, onSet }: SelectEditorProps) {
  const current = typeof entry.value === "string" ? entry.value : null;

  return (
    <Select value={current} onValueChange={(next) => next && onSet(next)}>
      <SelectTrigger size="sm" className="w-40">
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent>
        {values.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
