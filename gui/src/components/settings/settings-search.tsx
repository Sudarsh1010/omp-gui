/**
 * The Settings chrome bar's search field (#28, issue #19 story #19/#20):
 * a controlled `InputGroupInput` the layout focuses on ⌘F/Ctrl+F
 * (registered in `settings-layout.tsx`'s existing keydown handler,
 * `event.preventDefault()`d there so the browser's own find-in-page never
 * opens). Enter navigates to the first hit, mirroring a result row's
 * click (`search-results.tsx`). Esc clears and blurs the field while it
 * has text via `event.preventDefault()` — the layout's Esc-back handler
 * checks `event.defaultPrevented` before treating an Esc as "leave
 * Settings", so a clearing Esc never also navigates away; an Esc on an
 * already-empty field does nothing here and falls through to that
 * back-navigation normally.
 */
import type { RefObject } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@omp-gui/ui/components/input-group";
import type { SearchHit } from "@omp-gui/ipc";

export interface SettingsSearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  hits: SearchHit[];
  onNavigate: (hit: SearchHit) => void;
}

export function SettingsSearch({ inputRef, value, onChange, hits, onNavigate }: SettingsSearchProps) {
  return (
    <InputGroup className="ml-auto h-7 w-64">
      <InputGroupAddon>
        <MagnifyingGlassIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        value={value}
        placeholder="Search settings…"
        aria-label="Search settings"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (hits.length > 0) onNavigate(hits[0]);
            return;
          }
          if (event.key !== "Escape" || value.length === 0) return;
          event.preventDefault();
          onChange("");
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}
