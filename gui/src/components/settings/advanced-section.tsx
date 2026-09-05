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
 * of going blank, with a one-line note explaining why every key is
 * listed rather than just the schema's uiless set.
 *
 * A key claimed by a bespoke section (`claims.ts`) renders as a pointer
 * row — "Edited in <label>" plus a `Link` to that section — instead of a
 * second editor. Every other row's editor is `pickEditor`'s choice
 * (`editors/config-editor.tsx`, shared with `schema-tab-section.tsx`),
 * keyed by `ConfigEntry.valueType` and upgraded with schema metadata
 * (secret/enum choices/options) once the schema resolves; `modified` and
 * the hover "Reset to default" action (`UnsetButton`) only render once a
 * schema default is known to compare against.
 */
import { useMemo } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { jsonValueEquals, type ConfigEntry } from "@omp-gui/ipc";
import { useSettingsContext } from "./settings-context";
import { useSettings } from "@gui/settings/use-settings";
import { useConfigSchema } from "@gui/settings/use-config-schema";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";
import { SettingsGroup } from "./settings-group";
import { SettingsRow, rowStatusFromState, type RowStatus } from "./settings-row";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SessionsNote } from "./sessions-note";
import { UnsetButton } from "./unset-button";
import { CLAIMED_KEYS } from "./claims";
import type { SectionId } from "./sections";
import { pickEditor, useLocalConfigErrors } from "./editors/config-editor";

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
  const { localErrors, setLocalError } = useLocalConfigErrors();

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

  function renderRow(entry: ConfigEntry): ReactNode {
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

    const schemaEntry = schemaByKey?.get(entry.key);
    const modified = schemaEntry ? !jsonValueEquals(entry.value, schemaEntry.default) : undefined;
    const localError = localErrors.get(entry.key);
    const status: RowStatus = localError
      ? { kind: "rejected", message: localError }
      : rowStatusFromState(snapshot.rows.get(entry.key));
    const rejected = snapshot.rows.get(entry.key)?.rejected;
    const onSet = (value: unknown) => {
      setLocalError(entry.key, undefined);
      void controller.set(entry.key, value);
    };
    const onInvalid = (message: string | undefined) => setLocalError(entry.key, message);

    return (
      <SettingsRow
        key={entry.key}
        rowKey={`advanced.${entry.key}`}
        label={entry.key}
        description={entry.description}
        keyPath={entry.key}
        modified={modified}
        status={status}
      >
        {modified && <UnsetButton onUnset={() => void controller.unset(entry.key)} />}
        {pickEditor({
          value: entry,
          valueType: entry.valueType,
          schema: schemaEntry,
          rejected,
          onSet,
          onInvalid,
        })}
      </SettingsRow>
    );
  }

  return (
    <>
      {schemaState.status === "unavailable" && (
        <p className="px-1 text-xs text-muted-foreground">
          This omp predates{" "}
          <code className="bg-muted px-1 font-mono text-[11px]">config schema</code>; every key is
          listed here.
        </p>
      )}
      {groups.map(([group, entries]) => (
        <SettingsGroup key={group} title={group}>
          {entries.map(renderRow)}
        </SettingsGroup>
      ))}
      <SessionsNote />
    </>
  );
}
