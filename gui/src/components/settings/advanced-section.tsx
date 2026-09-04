/**
 * Advanced section (#24, issue #19 story #16; ADR-0011 "no key ever has
 * two editors"): grouped by dot-prefix (`retry.*`, `browser.*`, … — the
 * same grouping `omp config list --json`'s own key namespacing implies,
 * see `04-omp-cli-surface.md` §1; a bare top-level key like `autoResume`
 * groups under "General") and sorted by key.
 *
 * #26 shrinks the rendered set once `config schema --json` resolves: only
 * keys `SchemaEntry.tab` never names (the schema's own "no UI" keys,
 * `uilessKeys` below) plus every `CLAIMED_KEYS` pointer are shown — every
 * other key already has a generic editor on its schema tab, and ADR-0011
 * forbids a key ever having two. While the schema is still loading, or on
 * an override binary old enough to lack `config schema` entirely
 * (`schemaState.status === "unavailable"`), `uilessKeys` stays `undefined`
 * and every key `configList()` reports renders here — ADR-0011's
 * guaranteed Advanced-only fallback so an old override degrades instead
 * of going blank.
 *
 * A key claimed by a bespoke section (`claims.ts`) renders as a pointer
 * row — "Edited in <label>" plus a `Link` to that section — instead of a
 * second editor. Every other row's editor is chosen by `ConfigEntry
 * .valueType`, upgraded to a write-only field when `redacted` or the
 * schema marks it `secret`, and to a `Select` when the schema (once
 * loaded) names the key's enum choices.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ConfigEntry } from "@omp-gui/ipc";
import { useSettingsContext } from "./settings-context";
import { useSettings } from "@gui/settings/use-settings";
import { useConfigSchema } from "@gui/settings/use-config-schema";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";
import { SettingsGroup } from "./settings-group";
import { SettingsRow, rowStatusFromState, type RowStatus } from "./settings-row";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SessionsNote } from "./sessions-note";
import { CLAIMED_KEYS } from "./claims";
import type { SectionId } from "./sections";
import { SwitchEditor } from "./editors/switch-editor";
import { NumberEditor } from "./editors/number-editor";
import { TextEditor } from "./editors/text-editor";
import { JsonEditor } from "./editors/json-editor";
import { SecretEditor } from "./editors/secret-editor";
import { SelectEditor } from "./editors/select-editor";

function keyGroup(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? "General" : key.slice(0, dot);
}

function sectionPath(section: SectionId): string {
  return section.startsWith("tab:") ? `/settings/${section.slice(4)}` : `/settings/${section}`;
}

export function AdvancedSection() {
  const { bridge, settings } = useSettingsContext();
  if (!settings) {
    throw new Error("AdvancedSection requires routes/settings.tsx's SettingsController in context");
  }
  const controller = settings;
  const snapshot = useSettings(controller);
  const schemaState = useConfigSchema(bridge);
  const useBundled = useBundledOmp();
  const navigate = useNavigate();
  const [localErrors, setLocalErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const schemaByKey = useMemo(
    () =>
      schemaState.status === "ready"
        ? new Map(schemaState.schema.settings.map((s) => [s.key, s]))
        : undefined,
    [schemaState],
  );

  const uilessKeys = useMemo(
    () =>
      schemaState.status === "ready"
        ? new Set(schemaState.schema.settings.filter((s) => !s.tab).map((s) => s.key))
        : undefined,
    [schemaState],
  );

  const groups = useMemo(() => {
    const visible = [...snapshot.entries.values()].filter(
      (entry) => !uilessKeys || uilessKeys.has(entry.key) || CLAIMED_KEYS[entry.key],
    );
    const sorted = visible.sort((a, b) => a.key.localeCompare(b.key));
    const byGroup = new Map<string, ConfigEntry[]>();
    for (const entry of sorted) {
      const group = keyGroup(entry.key);
      const bucket = byGroup.get(group);
      if (bucket) bucket.push(entry);
      else byGroup.set(group, [entry]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot.entries, uilessKeys]);

  if (snapshot.status === "loading" && snapshot.entries.size === 0) {
    return <SectionSkeleton rows={8} />;
  }

  if (snapshot.status === "error") {
    return (
      <SectionError
        title="Advanced settings unavailable"
        stage={snapshot.error?.stage}
        message={snapshot.error?.message ?? "omp is unreachable."}
        onUseBundled={() => void useBundled()}
        onOpenAppPreferences={() => void navigate({ to: "/settings/app-preferences" })}
      />
    );
  }

  function setLocalError(key: string, message: string | undefined) {
    setLocalErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  }

  function renderEditor(entry: ConfigEntry): ReactNode {
    const schemaEntry = schemaByKey?.get(entry.key);
    const onSet = (value: unknown) => {
      setLocalError(entry.key, undefined);
      void controller.set(entry.key, value);
    };
    // Text/number/JSON editors buffer their own draft text in local
    // state, so a rejection (which leaves `entries` — and therefore
    // `saved`/`entry.value` — untouched) can't revert them just by
    // re-rendering with the same props. Keying on the rejection message
    // remounts the editor whenever a rejection appears or clears,
    // resetting its draft back to the entry's last-known-good value
    // (switch/select need no such key: they read `entry.value` directly
    // with no local buffer to revert).
    const rejected = snapshot.rows.get(entry.key)?.rejected;

    if (entry.redacted || schemaEntry?.secret) {
      return <SecretEditor entry={entry} onSet={onSet} />;
    }
    switch (entry.valueType) {
      case "boolean":
        return <SwitchEditor entry={entry} onSet={onSet} />;
      case "enum": {
        const values = schemaEntry?.values;
        return values && values.length > 0 ? (
          <SelectEditor
            entry={entry}
            options={values.map((value) => ({ value, label: value }))}
            onSet={onSet}
          />
        ) : (
          <TextEditor key={rejected} entry={entry} onSet={onSet} />
        );
      }
      case "number":
        return <NumberEditor key={rejected} entry={entry} onSet={onSet} />;
      case "array":
      case "record":
        return (
          <JsonEditor
            key={rejected}
            entry={entry}
            onSet={onSet}
            onInvalid={(message) => setLocalError(entry.key, message)}
          />
        );
      default:
        return <TextEditor key={rejected} entry={entry} onSet={onSet} />;
    }
  }

  return (
    <>
      {groups.map(([group, entries]) => (
        <SettingsGroup key={group} title={group}>
          {entries.map((entry) => {
            const claim = CLAIMED_KEYS[entry.key];
            if (claim) {
              return (
                <SettingsRow
                  key={entry.key}
                  rowKey={`advanced.${entry.key}`}
                  label={entry.key}
                  description={`Edited in ${claim.label}`}
                  keyPath={entry.key}
                >
                  <Link
                    to={sectionPath(claim.section)}
                    className="text-xs text-foreground underline-offset-2 hover:underline"
                  >
                    {claim.label} →
                  </Link>
                </SettingsRow>
              );
            }
            const localError = localErrors.get(entry.key);
            const status: RowStatus = localError
              ? { kind: "rejected", message: localError }
              : rowStatusFromState(snapshot.rows.get(entry.key));
            return (
              <SettingsRow
                key={entry.key}
                rowKey={`advanced.${entry.key}`}
                label={entry.key}
                description={entry.description}
                keyPath={entry.key}
                status={status}
              >
                {renderEditor(entry)}
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      ))}
      <SessionsNote />
    </>
  );
}
