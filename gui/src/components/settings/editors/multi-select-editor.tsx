/**
 * Array-with-options schema-tab editor (#26, issue #19): a `ToggleGroup`
 * over the schema's declared choices, writing the full membership array
 * on every change (a discrete control, per the Settings save model).
 *
 * When `SchemaEntry.ordered` is set, selection order is meaningful (issue
 * #19 "ordered lists of models per role" is the general case this covers)
 * — the current order renders above the toggle group with a position
 * number and up/down `Button`s per row, reordering in place without
 * changing membership. The toggle group below still owns adding/removing
 * membership; a value newly toggled on lands whichever way the toggle
 * group's own event orders it and can then be moved into place.
 */
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { Button } from "@omp-gui/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@omp-gui/ui/components/toggle-group";
import type { ConfigEditorProps } from "./config-editor";
import type { SelectOption } from "./select-editor";

export interface MultiSelectEditorProps extends ConfigEditorProps {
  options: SelectOption[];
  ordered?: boolean;
}

export function MultiSelectEditor({ entry, options, ordered, onSet }: MultiSelectEditorProps) {
  const selected = Array.isArray(entry.value)
    ? entry.value.filter((value): value is string => typeof value === "string")
    : [];

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    onSet(next);
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      {ordered && selected.length > 0 && (
        <div className="flex w-full flex-col gap-0.5">
          {selected.map((value, index) => (
            <div key={value} className="flex items-center gap-1.5 text-xs">
              <span className="w-3 text-right text-[11px] text-muted-foreground">{index + 1}</span>
              <span className="flex-1 truncate">
                {options.find((o) => o.value === value)?.label ?? value}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Move down"
                disabled={index === selected.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
      <ToggleGroup multiple size="sm" value={selected} onValueChange={(next) => onSet(next)}>
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} title={option.description}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
