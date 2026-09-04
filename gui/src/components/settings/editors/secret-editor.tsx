/**
 * Write-only Advanced-section editor (#24, issue #19 story #17) for
 * `redacted` config entries and schema `secret` keys: omp never echoes
 * the current value (`ConfigEntry.value` is omitted whenever `redacted`
 * is true), so this never shows one. Typing and committing (blur/Enter)
 * replaces the stored secret; the field always renders blank afterward —
 * there is nothing it could show without asking omp to leak the value.
 */
import { useState } from "react";
import { Input } from "@omp-gui/ui/components/input";
import type { ConfigEditorProps } from "./config-editor";

export function SecretEditor({ onSet }: ConfigEditorProps) {
  const [value, setValue] = useState("");

  return (
    <Input
      type="password"
      value={value}
      placeholder="set to replace"
      className="w-56"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value === "") return;
        onSet(value);
        setValue("");
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
