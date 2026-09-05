/**
 * Shared prop contract every Advanced-section/schema-tab editor (#24/#26,
 * issue #19) implements, plus the one place both sections pick an editor
 * from a value's type (`pickEditor`) and derive their per-row local
 * validation errors (`useLocalConfigErrors`) — `advanced-section.tsx` and
 * `schema-tab-section.tsx` each used to carry their own copy of both;
 * this is the single source now, so a new value type or editor is added
 * in exactly one place. `onSet` fires the raw value straight at
 * `SettingsController.set` — the controller (not the editor) owns
 * pending/saved/rejected per-row state, so an editor never awaits it or
 * renders its own status text for a server rejection; the caller derives
 * each row's `SettingsRow status` from the controller's `rows` map.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import type { ConfigEntry, SchemaEntry } from "@omp-gui/ipc";
import { SwitchEditor } from "./switch-editor";
import { TextEditor } from "./text-editor";
import { JsonEditor } from "./json-editor";
import { SecretEditor } from "./secret-editor";
import { SelectEditor, type SelectOption } from "./select-editor";
import { MultiSelectEditor } from "./multi-select-editor";

export interface ConfigEditorProps {
  entry: ConfigEntry;
  onSet: (value: unknown) => void;
}

/** Resolves `SchemaEntry.options` into `{value,label,description}` rows
 * when the schema names an array of submenu choices; `undefined` for
 * `null` or the literal `"runtime"` marker (the caller falls back to a
 * free-text field for that case, and to `SchemaEntry.values` for a plain
 * enum with no `options` array). */
export function optionsFromEntry(entry: SchemaEntry): SelectOption[] | undefined {
  if (!Array.isArray(entry.options)) return undefined;
  const options: SelectOption[] = [];
  for (const item of entry.options) {
    if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof item.value === "string"
    ) {
      options.push({
        value: item.value,
        label: typeof item.label === "string" ? item.label : item.value,
        description: typeof item.description === "string" ? item.description : undefined,
      });
    }
  }
  return options;
}

export interface PickEditorArgs {
  /** The live value to render/edit. */
  value: ConfigEntry;
  /** The value's declared type — `ConfigEntry.valueType`/`SchemaEntry.type`
   * share the same enumeration. */
  valueType: ConfigEntry["valueType"];
  /** The schema's own description of this key, when resolved — supplies
   * `secret`/enum `values`/`options`/`ordered`. Advanced only has this
   * once `config schema` resolves; schema tabs always do. */
  schema?: SchemaEntry;
  /** Remounts a text-buffering editor (text/number/JSON) so a rejection
   * reverts its draft back to the last-known-good value — keyed on the
   * rejection message by the caller (`snapshot.rows.get(key)?.rejected`). */
  rejected: string | undefined;
  onSet: (value: unknown) => void;
  onInvalid: (message: string | undefined) => void;
}

/** Chooses the editor for one config value, shared by `advanced-
 * section.tsx` (every key, uniform Advanced rendering) and `schema-tab-
 * section.tsx` (schema-driven tabs, always with richer `schema` metadata)
 * so a value type is never wired to an editor in two places. */
export function pickEditor({
  value,
  valueType,
  schema,
  rejected,
  onSet,
  onInvalid,
}: PickEditorArgs): ReactNode {
  if (value.redacted || schema?.secret) {
    return <SecretEditor entry={value} onSet={onSet} />;
  }
  switch (valueType) {
    case "boolean":
      return <SwitchEditor entry={value} onSet={onSet} />;
    case "enum": {
      const options =
        (schema && optionsFromEntry(schema)) ??
        (schema?.values ?? []).map((v) => ({ value: v, label: v }));
      return options.length > 0 ? (
        <SelectEditor entry={value} options={options} onSet={onSet} />
      ) : (
        <TextEditor key={rejected} entry={value} onSet={onSet} />
      );
    }
    case "number":
      return <TextEditor key={rejected} kind="number" entry={value} onSet={onSet} />;
    case "string": {
      if (schema?.options === "runtime") {
        return <TextEditor key={rejected} entry={value} onSet={onSet} />;
      }
      const options = schema && optionsFromEntry(schema);
      return options ? (
        <SelectEditor entry={value} options={options} onSet={onSet} />
      ) : (
        <TextEditor key={rejected} entry={value} onSet={onSet} />
      );
    }
    case "array": {
      const options = schema && optionsFromEntry(schema);
      return options ? (
        <MultiSelectEditor
          entry={value}
          options={options}
          ordered={schema?.ordered}
          onSet={onSet}
        />
      ) : (
        <JsonEditor key={rejected} entry={value} onSet={onSet} onInvalid={onInvalid} />
      );
    }
    case "record":
      return <JsonEditor key={rejected} entry={value} onSet={onSet} onInvalid={onInvalid} />;
    default:
      return <TextEditor key={rejected} entry={value} onSet={onSet} />;
  }
}

/** Per-key local validation errors that never reach `SettingsController`
 * (a `JsonEditor` parse failure, reported through `onInvalid` rather than
 * `onSet` — the controller's own `rows` map has nothing to say about a
 * value that was never sent to omp at all). Shared by `advanced-
 * section.tsx` and `schema-tab-section.tsx`, which each used to carry an
 * identical copy of this `Map` derivation. */
export function useLocalConfigErrors() {
  const [localErrors, setLocalErrors] = useState<ReadonlyMap<string, string>>(new Map());

  function setLocalError(key: string, message: string | undefined) {
    setLocalErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  }

  return { localErrors, setLocalError };
}
