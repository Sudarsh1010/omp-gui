/**
 * String/number Advanced-section editor (#24, issue #19): commits on blur
 * or Enter, per the Settings save model's text-field rule. The raw text
 * is handed straight to `onSet` — omp's own `config set` validator is the
 * only source of truth for whether a value is acceptable
 * (`platform/ipc/src/settings/serialize.ts`'s doc comment; for `kind:
 * "number"` it reports "Invalid number: …" for anything it can't read).
 * One component for both kinds — they differed only in the input's
 * `type` attribute and width.
 */
import { useEffect, useState } from "react";
import { Input } from "@omp-gui/ui/components/input";
import type { ConfigEditorProps } from "./config-editor";

function toText(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

export interface TextEditorProps extends ConfigEditorProps {
  kind?: "text" | "number";
}

export function TextEditor({ entry, onSet, kind = "text" }: TextEditorProps) {
  const saved = toText(entry.value);
  const [value, setValue] = useState(saved);

  useEffect(() => setValue(saved), [saved]);

  return (
    <Input
      type={kind}
      value={value}
      className={kind === "number" ? "w-32 min-w-0" : "w-64 min-w-0"}
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
