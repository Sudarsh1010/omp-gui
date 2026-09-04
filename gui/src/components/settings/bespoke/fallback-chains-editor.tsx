/**
 * Fallback chains editor (#29, issue #19 story #28; ADR-0011 "Bespoke
 * sections"): claims `retry.fallbackChains` out of the Model tab's
 * "Retry & Fallback" group and renders it as one row per record key —
 * the `smol`/`default`/`slow` roles always shown first (even absent),
 * then any model-selector or `provider/*`-wildcard key already in the
 * record — each an ordered list of model chips (`Badge`) with up/down/
 * remove controls, plus an "Add" picker sourced from the Models catalog
 * (`bridge.modelsList()`, via the tiny local `useModelsList` hook — a
 * free-text input substitutes when the catalog is unavailable). An
 * "Add key" input appends a new custom key.
 */
import { useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import {
  addChainEntry,
  addChainKey,
  moveChainEntry,
  removeChainKey,
  type FallbackChainsRecord,
} from "@omp-gui/ipc";
import { Badge } from "@omp-gui/ui/components/badge";
import { Button } from "@omp-gui/ui/components/button";
import { Input } from "@omp-gui/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@omp-gui/ui/components/select";
import { useSettingsContext } from "../settings-context";
import { useModelsList } from "./use-models-list";
import type { BespokeEditorProps } from "./bespoke-editor";

const ROLE_KEYS = ["smol", "default", "slow"];

export function FallbackChainsEditor({ entry, value }: BespokeEditorProps) {
  const { bridge, settings } = useSettingsContext();
  if (!settings) {
    throw new Error("FallbackChainsEditor requires routes/settings.tsx's SettingsController in context");
  }
  const controller = settings;
  const rows = useSyncExternalStore(controller.subscribe, () => controller.snapshot().rows);
  const models = useModelsList(bridge);
  const [newKey, setNewKey] = useState("");
  const [manualDrafts, setManualDrafts] = useState<Record<string, string>>({});

  const record = (value?.value as FallbackChainsRecord | undefined) ?? {};

  const keys = useMemo(() => {
    const ordered = [...ROLE_KEYS];
    for (const key of Object.keys(record)) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    return ordered;
  }, [record]);

  function writeRecord(next: FallbackChainsRecord) {
    void controller.set(entry.key, next);
  }

  function addKeyRow() {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    writeRecord(addChainKey(record, trimmed));
    setNewKey("");
  }

  const rowState = rows.get(entry.key);

  return (
    <div className="flex flex-col">
      <div className="flex min-h-8 items-center justify-between gap-2 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground" title={entry.key}>
            Fallback Chains
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
      {keys.map((key) => {
        const chain = record[key] ?? [];
        const isRole = ROLE_KEYS.includes(key);
        const manualDraft = manualDrafts[key] ?? "";
        return (
          <div
            key={key}
            data-settings-row={`tab.retry.fallbackChains.${key}`}
            id={`row-tab.retry.fallbackChains.${key}`}
            className="flex flex-col gap-1.5 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-foreground">{key}</span>
              {!isRole && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${key}`}
                  title="Remove key"
                  onClick={() => writeRecord(removeChainKey(record, key))}
                >
                  <XIcon />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {chain.map((selector, index) => (
                <Badge key={`${selector}-${index}`} variant="outline" className="gap-1 py-1">
                  <span className="font-mono">{selector}</span>
                  <button
                    type="button"
                    aria-label={`Move ${selector} up`}
                    disabled={index === 0}
                    className="disabled:opacity-30"
                    onClick={() => writeRecord(moveChainEntry(record, key, index, "up"))}
                  >
                    <CaretUpIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${selector} down`}
                    disabled={index === chain.length - 1}
                    className="disabled:opacity-30"
                    onClick={() => writeRecord(moveChainEntry(record, key, index, "down"))}
                  >
                    <CaretDownIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${selector}`}
                    onClick={() => writeRecord(moveChainEntry(record, key, index, "remove"))}
                  >
                    <XIcon />
                  </button>
                </Badge>
              ))}
              {models.status === "ready" ? (
                <Select<string>
                  value={null}
                  onValueChange={(selector) => selector && writeRecord(addChainEntry(record, key, selector))}
                  disabled={models.models.length === 0}
                >
                  <SelectTrigger size="sm" className="w-56">
                    <SelectValue placeholder="Add model…" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.models.map((model) => (
                      <SelectItem key={model.selector} value={model.selector}>
                        {model.provider} — {model.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Input
                    placeholder="provider/model-id…"
                    value={manualDraft}
                    onChange={(event) =>
                      setManualDrafts((prev) => ({ ...prev, [key]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      writeRecord(addChainEntry(record, key, manualDraft));
                      setManualDrafts((prev) => ({ ...prev, [key]: "" }));
                    }}
                    className="w-48"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!manualDraft.trim()}
                    onClick={() => {
                      writeRecord(addChainEntry(record, key, manualDraft));
                      setManualDrafts((prev) => ({ ...prev, [key]: "" }));
                    }}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2 px-3 py-2">
        <Input
          placeholder="provider/* or custom key…"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addKeyRow();
          }}
          className="w-56"
        />
        <Button variant="outline" size="sm" disabled={!newKey.trim()} onClick={addKeyRow}>
          Add key
        </Button>
      </div>
    </div>
  );
}
