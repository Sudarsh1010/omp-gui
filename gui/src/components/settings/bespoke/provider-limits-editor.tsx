/**
 * Provider limits editor (#29, issue #19 story #29; ADR-0011 "Bespoke
 * sections"): claims `providers.maxInFlightRequests` out of the
 * Providers tab's "Services" group and renders it as one provider →
 * concurrency-number row instead of the generic record's raw JSON
 * editor. Provider ids are the union of the Models catalog's provider
 * ids (`bridge.modelsList()`) and any provider id already present in the
 * record (an override binary's provider the catalog doesn't know about).
 *
 * Each input validates locally (`validateLimit`, positive integers only)
 * before ever calling `SettingsController.set` — an invalid draft renders
 * a rejected-styled row and is never written; an empty draft removes the
 * provider from the record (no limit). Commits on blur or Enter, per the
 * Settings save model's text/number-field rule.
 */
import { useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import { setProviderLimit, validateLimit, type ProviderLimitsRecord } from "@omp-gui/ipc";
import { Input } from "@omp-gui/ui/components/input";
import { useSettingsContext } from "../settings-context";
import { useModelsList } from "./use-models-list";
import type { BespokeEditorProps } from "./bespoke-editor";

export function ProviderLimitsEditor({ entry, value }: BespokeEditorProps) {
  const { bridge, settings } = useSettingsContext();
  if (!settings) {
    throw new Error("ProviderLimitsEditor requires routes/settings.tsx's SettingsController in context");
  }
  const controller = settings;
  const rows = useSyncExternalStore(controller.subscribe, () => controller.snapshot().rows);
  const models = useModelsList(bridge);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const record = (value?.value as ProviderLimitsRecord | undefined) ?? {};

  const providers = useMemo(() => {
    const ordered: string[] = [];
    const catalogIds = models.status === "ready" ? models.models.map((m) => m.provider) : [];
    for (const id of [...catalogIds, ...Object.keys(record)]) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered.sort();
  }, [models, record]);

  function textFor(provider: string): string {
    if (provider in drafts) return drafts[provider];
    return record[provider] != null ? String(record[provider]) : "";
  }

  function commit(provider: string) {
    const text = textFor(provider);
    const savedText = record[provider] != null ? String(record[provider]) : "";
    if (text === savedText) return;

    const result = validateLimit(text);
    if (result.kind === "invalid") {
      setLocalErrors((prev) => ({ ...prev, [provider]: result.message }));
      return;
    }
    setLocalErrors((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    void controller.set(entry.key, setProviderLimit(record, provider, result.kind === "valid" ? result.value : undefined));
  }

  const rowState = rows.get(entry.key);

  return (
    <div className="flex flex-col">
      <div className="flex min-h-8 items-center justify-between gap-2 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground" title={entry.key}>
            Provider Limits
          </span>
          {entry.description && <p className="text-xs text-muted-foreground">{entry.description}</p>}
        </div>
        {rowState?.rejected && (
          <span className="shrink-0 bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
            {rowState.rejected}
          </span>
        )}
        {!rowState?.rejected && rowState?.saved && (
          <span className="shrink-0 text-xs text-muted-foreground">Saved</span>
        )}
      </div>
      {providers.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No providers discovered — configure at least one provider credential to populate this
          list.
        </p>
      )}
      {providers.map((provider) => {
        const localError = localErrors[provider];
        return (
          <div
            key={provider}
            data-settings-row={`tab.providers.maxInFlightRequests.${provider}`}
            id={`row-tab.providers.maxInFlightRequests.${provider}`}
            className="flex min-h-8 items-center justify-between gap-4 px-3 py-2"
          >
            <span className="truncate font-mono text-xs text-foreground">{provider}</span>
            <div className="flex shrink-0 items-center gap-2">
              {localError && (
                <span className="bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                  {localError}
                </span>
              )}
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="Unlimited"
                value={textFor(provider)}
                aria-invalid={Boolean(localError)}
                className="w-24 min-w-0"
                onChange={(event) => {
                  setDrafts((prev) => ({ ...prev, [provider]: event.target.value }));
                  if (localError) {
                    setLocalErrors((prev) => {
                      const next = { ...prev };
                      delete next[provider];
                      return next;
                    });
                  }
                }}
                onBlur={() => commit(provider)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
