/**
 * Advanced section (#24, issue #19 story #16; ADR-0011 "no key ever has
 * two editors"): every key `config list --json` reports, sorted by key
 * and grouped by its dot-prefix (`retry.*`, `browser.*`, … — the same
 * grouping `omp config list --json`'s own key namespacing implies, see
 * `04-omp-cli-surface.md` §1; a bare top-level key like `autoResume`
 * groups under "General") — the catch-all rendering issue #19 story #16
 * asks for ("settings omp's own panel hides... collected under Advanced
 * with a typed editor, so that 'all config' really means all"), and
 * ADR-0011's guaranteed fallback when an override binary predates
 * `config schema` (#26's schema-driven tabs have nothing to render, but
 * this section only ever depends on `configList`).
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
import type { ConfigEntry, RowState } from "@omp-gui/ipc";
import { useSettingsContext } from "./settings-context";
import { useSettings } from "@gui/settings/use-settings";
import { useConfigSchema } from "@gui/settings/use-config-schema";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";
import { SettingsGroup } from "./settings-group";
import { SettingsRow, type RowStatus } from "./settings-row";
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

function toRowStatus(row: RowState | undefined): RowStatus {
  if (!row) return { kind: "idle" };
  if (row.rejected) return { kind: "rejected", message: row.rejected };
  if (row.saved) return { kind: "saved" };
  if (row.pending) return { kind: "saving" };
  return { kind: "idle" };
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
    () => (schemaState.status === "ready" ? new Map(schemaState.schema.settings.map((s) => [s.key, s])) : undefined),
    [schemaState],
  );

  const groups = useMemo(() => {
    const sorted = [...snapshot.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
    const byGroup = new Map<string, ConfigEntry[]>();
    for (const entry of sorted) {
      const group = keyGroup(entry.key);
      const bucket = byGroup.get(group);
      if (bucket) bucket.push(entry);
      else byGroup.set(group, [entry]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot.entries]);

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
          <SelectEditor entry={entry} values={values} onSet={onSet} />
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
              : toRowStatus(snapshot.rows.get(entry.key));
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
