/**
 * Array/record Advanced-section editor (#24, issue #19): a JSON
 * `Textarea`, validated client-side before write since there is no
 * discrete control shaped like arbitrary JSON. A parse failure never
 * reaches `SettingsController.set` — `advanced-section.tsx` renders it as
 * an inline rejected row status the same way a server rejection would,
 * but it is reported through `onInvalid` rather than `onSet` because the
 * controller's own `rows` map has nothing to say about a value that was
 * never sent to omp at all.
 */
import { useEffect, useState } from "react";
import { Textarea } from "@omp-gui/ui/components/textarea";
import type { ConfigEditorProps } from "./config-editor";

export interface JsonEditorProps extends ConfigEditorProps {
  onInvalid: (message: string | undefined) => void;
}

export function JsonEditor({ entry, onSet, onInvalid }: JsonEditorProps) {
  const saved = JSON.stringify(entry.value ?? (entry.valueType === "record" ? {} : []), null, 2);
  const [value, setValue] = useState(saved);

  useEffect(() => setValue(saved), [saved]);

  return (
    <Textarea
      value={value}
      className="w-64 min-w-0 font-mono text-[11px]"
      rows={4}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value === saved) return;
        try {
          const parsed: unknown = JSON.parse(value);
          onInvalid(undefined);
          onSet(parsed);
        } catch {
          onInvalid(`Invalid ${entry.valueType} JSON`);
        }
      }}
    />
  );
}
