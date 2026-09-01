import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { IpcSessionHandle } from "@omp-gui/ipc";
import { Alert, AlertDescription, AlertTitle } from "@omp-gui/ui/components/alert";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { Composer } from "@gui/components/session/composer";
import { TranscriptView } from "@gui/components/session/transcript-view";
import { useTranscript } from "@gui/components/session/use-transcript";

type Status = "starting" | "ready" | "error";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { ipc } = useRouteContext({ from: "__root__" });
  const [handle, setHandle] = useState<IpcSessionHandle | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let activeHandle: IpcSessionHandle | null = null;
    setStatus("starting");
    setError(null);
    void (async () => {
      try {
        const started = await ipc.startSession();
        if (cancelled) {
          await started.close();
          return;
        }
        activeHandle = started;
        setHandle(started);
        setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      setHandle(null);
      void activeHandle?.close();
    };
  }, [ipc]);

  const { snapshot, sendPrompt, abort } = useTranscript(handle?.session);

  return (
    <main className="mx-auto flex h-dvh max-w-[64em] flex-col gap-3 px-4 py-4">
      <header className="flex shrink-0 items-center justify-between">
        <h1 className="text-sm font-medium">omp-gui session</h1>
        {handle && (
          <span className="text-xs text-muted-foreground">
            omp {handle.info.version} ({handle.info.source}) · protocol v{handle.session.protocolVersion}
          </span>
        )}
      </header>

      {status === "starting" && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Starting omp…
        </div>
      )}

      {status === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Failed to start session</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {status === "ready" && (
        <>
          <TranscriptView entries={snapshot.entries} className="flex-1" />
          <Composer running={snapshot.running} aborting={snapshot.aborting} onSubmit={sendPrompt} onAbort={abort} />
        </>
      )}
    </main>
  );
}
