/**
 * Number Advanced-section editor (#24, issue #19): commits on blur or
 * Enter, same as `text-editor.tsx` — a numeric `<input type="number">`
 * keyboard, but still text-editor commit semantics, and still just
 * hands the raw text to `onSet`; omp's `config set` parser reports
 * "Invalid number: …" for anything it can't read.
 */
import { useEffect, useState } from "react";
import { Input } from "@omp-gui/ui/components/input";
import type { ConfigEditorProps } from "./config-editor";

function toText(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

export function NumberEditor({ entry, onSet }: ConfigEditorProps) {
  const saved = toText(entry.value);
  const [value, setValue] = useState(saved);

  useEffect(() => setValue(saved), [saved]);

  return (
    <Input
      type="number"
      value={value}
      className="w-32"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value !== saved) onSet(value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
