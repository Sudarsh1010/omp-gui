/**
 * Enum/labeled-choice editor (#24 Advanced, #26 schema tabs; issue #19):
 * a discrete control that writes on change. `options` is a caller-
 * resolved `{value, label}` list — Advanced derives plain labels from
 * `SchemaEntry.values` (`config list --json` never carries enum choices
 * itself, see `bindings.gen.ts`'s `SchemaEntry` doc comment); the schema
 * tabs (`schema-tab-section.tsx`) resolve richer `{value, label,
 * description}` triples from `SchemaEntry.options` when the schema names
 * them, falling back to plain `values` otherwise.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@omp-gui/ui/components/select";
import type { ConfigEditorProps } from "./config-editor";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SelectEditorProps extends ConfigEditorProps {
  options: SelectOption[];
}

export function SelectEditor({ entry, options, onSet }: SelectEditorProps) {
  const current = typeof entry.value === "string" ? entry.value : null;

  return (
    <Select value={current} onValueChange={(next) => next && onSet(next)}>
      <SelectTrigger size="sm" className="w-40">
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
