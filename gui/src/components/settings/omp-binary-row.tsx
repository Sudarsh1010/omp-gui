/**
 * The App Preferences omp-binary row (T23, issue #19/#23, ADR-0004): shows
 * which omp the app resolves to run (path in mono, version, a Bundled /
 * Override / Env badge), lets a power user type a custom path and smoke
 * -test it before it's ever used, and reverts to the bundled pin in one
 * click. The first successful commit of a non-bundled path opens this
 * page's one modal -- an explicit compatibility-risk acknowledgement
 * (ADR-0004) -- recorded in `localStorage` (never in App Preferences
 * itself, whose schema is fixed to the four ADR-0011 fields) so it is
 * asked at most once per browser profile.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from "@omp-gui/ui/components/alert-dialog";
import { Badge } from "@omp-gui/ui/components/badge";
import { Button } from "@omp-gui/ui/components/button";
import { Input } from "@omp-gui/ui/components/input";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { BridgeCommandError, type OmpBinaryInfo, type OmpBinarySource } from "@omp-gui/ipc";
import { useAppPreferences } from "@gui/settings/use-app-preferences";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";
import { invalidateConfigSchema } from "@gui/settings/use-config-schema";
import { useSettingsContext } from "./settings-context";
import { SettingsRow } from "./settings-row";

/** `localStorage` key recording that the user has already acknowledged
 * the compatibility-risk dialog once -- App Preferences' own schema is
 * fixed to the four ADR-0011 fields, so this cannot live there. */
const ACKNOWLEDGED_KEY = "omp-gui.omp-override-acknowledged";

function hasAcknowledgedOverride(): boolean {
  try {
    return window.localStorage.getItem(ACKNOWLEDGED_KEY) === "true";
  } catch {
    return false;
  }
}

function markOverrideAcknowledged(): void {
  try {
    window.localStorage.setItem(ACKNOWLEDGED_KEY, "true");
  } catch {
    // Best-effort: a storage-denied context (private browsing, quota)
    // just re-prompts next time, which is safe.
  }
}

function sourceBadgeLabel(source: OmpBinarySource | undefined): string {
  switch (source) {
    case "override":
      return "Env";
    case "preferenceOverride":
      return "Override";
    case "devBinary":
    case "bundled":
    case undefined:
      return "Bundled";
  }
}

interface Failure {
  stage: string;
  message: string;
}

function describeFailure(error: unknown): Failure {
  if (error instanceof BridgeCommandError) {
    const payload: unknown = error.error;
    if (payload && typeof payload === "object" && "stage" in payload && "message" in payload) {
      return { stage: String(payload.stage), message: String(payload.message) };
    }
    if (payload && typeof payload === "object" && "message" in payload) {
      return { stage: "preferences", message: String(payload.message) };
    }
  }
  return { stage: "error", message: error instanceof Error ? error.message : String(error) };
}

type RunState = { kind: "idle" } | { kind: "running" } | { kind: "failed"; failure: Failure };

interface PendingAcknowledgement {
  path: string;
  version: string;
}

export function OmpBinaryRow() {
  const { bridge, preferences, settings } = useSettingsContext();
  const useBundled = useBundledOmp();
  const snapshot = useAppPreferences(preferences);
  const committedPath = snapshot.prefs.ompPath ?? "";

  const [info, setInfo] = useState<OmpBinaryInfo | null>(null);
  const [draftPath, setDraftPath] = useState(committedPath);
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [pending, setPending] = useState<PendingAcknowledgement | null>(null);

  const loadInfo = useCallback(async () => {
    if (!bridge.ompBinaryInfo) return;
    const next = await bridge.ompBinaryInfo();
    setInfo(next);
  }, [bridge]);

  // Re-read the resolved binary whenever the committed override changes,
  // including out-of-band reverts from the degraded banner's "Use bundled
  // omp" (`use-bundled-omp.ts`), which only reloads preferences.
  useEffect(() => {
    void loadInfo();
  }, [loadInfo, committedPath]);

  // Keep the draft input in sync with the committed value whenever it
  // changes out-of-band (another writer, or this row's own "Use bundled
  // omp" / successful commit) -- never while the user is mid-edit, since
  // this only re-runs when `committedPath` itself changes.
  useEffect(() => {
    setDraftPath(committedPath);
  }, [committedPath]);

  // After the resolved binary changes (commit or revert), every omp-backed
  // source must re-read against it: `useBundledOmp` reloads preferences +
  // settings and re-fetches the schema; the same three steps apply after a
  // successful commit, whose binary may describe a different settings surface.
  const commit = useCallback(
    async (path: string) => {
      if (!bridge.ompOverrideCommit) return;
      setRun({ kind: "running" });
      try {
        const nextInfo = await bridge.ompOverrideCommit(path);
        setInfo(nextInfo);
        setRun({ kind: "idle" });
        await preferences.reload();
        invalidateConfigSchema();
        await settings?.reload();
      } catch (error) {
        setRun({ kind: "failed", failure: describeFailure(error) });
      }
    },
    [bridge, preferences, settings],
  );

  const handleTestAndUse = useCallback(async () => {
    const path = draftPath.trim();
    if (!path || !bridge.ompSmokeTest) return;
    setRun({ kind: "running" });
    try {
      const report = await bridge.ompSmokeTest(path);
      setRun({ kind: "idle" });
      if (hasAcknowledgedOverride()) {
        await commit(path);
      } else {
        setPending({ path, version: report.version });
      }
    } catch (error) {
      setRun({ kind: "failed", failure: describeFailure(error) });
    }
  }, [bridge, commit, draftPath]);

  const handleAcknowledge = useCallback(() => {
    if (!pending) return;
    markOverrideAcknowledged();
    const { path } = pending;
    setPending(null);
    void commit(path);
  }, [commit, pending]);

  const handleUseBundled = useCallback(async () => {
    setRun({ kind: "running" });
    try {
      await useBundled();
      setDraftPath("");
      setRun({ kind: "idle" });
    } catch (error) {
      setRun({ kind: "failed", failure: describeFailure(error) });
    }
  }, [useBundled]);

  const running = run.kind === "running";
  const hasDraftChange = draftPath.trim() !== committedPath && draftPath.trim() !== "";
  const canRevert = committedPath !== "";

  return (
    <>
      <SettingsRow rowKey="omp-binary" label="Which omp the app runs" keyPath="ompPath">
        <div className="flex w-full max-w-sm flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span
              className="max-w-sm truncate font-mono text-[11px] text-muted-foreground"
              title={info?.path || undefined}
            >
              {info?.path || "resolving…"}
            </span>
            {info?.version && <span className="text-xs text-muted-foreground">{info.version}</span>}
            <Badge variant="outline">{sourceBadgeLabel(info?.source)}</Badge>
            {info?.source === "preferenceOverride" && info.version === null && (
              <span className="bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                unavailable
              </span>
            )}
          </div>
          {info?.envOverrideActive && (
            <p className="max-w-sm text-right text-xs text-muted-foreground">
              OMP_GUI_OMP_PATH is set and always wins over a committed override.
            </p>
          )}
          <div className="flex w-full max-w-sm items-center gap-2">
            <Input
              value={draftPath}
              onChange={(event) => setDraftPath(event.target.value)}
              placeholder={info?.bundledVersion ? `Bundled (${info.bundledVersion})` : "Bundled"}
              className="font-mono text-[11px]"
              disabled={running}
            />
            {running ? (
              <Spinner />
            ) : (
              hasDraftChange && (
                <Button size="sm" variant="outline" onClick={() => void handleTestAndUse()}>
                  Test & use
                </Button>
              )
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={running || !canRevert}
              onClick={() => void handleUseBundled()}
            >
              Use bundled omp
            </Button>
            {run.kind === "idle" &&
              info?.source === "preferenceOverride" &&
              info.version !== null && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircleIcon className="size-3.5" /> in use
                </span>
              )}
          </div>
          {run.kind === "failed" && (
            <span className="max-w-sm bg-destructive/10 px-1.5 py-0.5 text-right text-xs text-destructive">
              {run.failure.stage}: {run.failure.message}
            </span>
          )}
        </div>
      </SettingsRow>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use a non-bundled omp?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs">{pending?.path}</span> (omp {pending?.version})
              passed the launch-time protocol smoke test, but it is not the pinned version this app
              is tested against. The rpc-ui wire surface is version-negotiated, not frozen — an
              incompatible release can behave unexpectedly or fail mid-session. Use bundled omp at
              any time to revert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleAcknowledge}>Use this omp</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
