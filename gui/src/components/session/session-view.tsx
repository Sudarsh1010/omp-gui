import type { SessionsStore } from "@omp-gui/ipc";
import { Alert, AlertDescription, AlertTitle } from "@omp-gui/ui/components/alert";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { WarningIcon } from "@phosphor-icons/react";
import { Composer } from "@gui/components/session/composer";
import { ModelPicker } from "@gui/components/session/model-picker";
import { TranscriptView } from "@gui/components/session/transcript-view";
import { useSessionSummary, useSessionTranscript } from "@gui/session/use-sessions";

export interface SessionViewProps {
  store: SessionsStore;
  sessionId: string;
}

/**
 * One session's live view: a header (title + model/thinking-level pickers,
 * T13), then either a connecting spinner, a start-failure alert, or the
 * transcript + composer.
 *
 * Wired to the `Transcript` the `SessionsStore` already owns for
 * `sessionId` — this component never constructs or disposes one itself, so
 * switching away and back doesn't lose a backgrounded session's history.
 */
export function SessionView({ store, sessionId }: SessionViewProps) {
  const summary = useSessionSummary(store, sessionId);
  const { snapshot, ready, sendPrompt, abort } = useSessionTranscript(store, sessionId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
      <header className="flex shrink-0 items-center justify-between gap-2">
        <h1 className="truncate text-sm font-medium">{summary?.title ?? "Session"}</h1>
        <ModelPicker store={store} sessionId={sessionId} />
      </header>

      {summary?.status === "error" ? (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>Session failed to start</AlertTitle>
          <AlertDescription>
            This session's omp subprocess never became ready. Close it and start a new one.
          </AlertDescription>
        </Alert>
      ) : !ready ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Starting omp…
        </div>
      ) : (
        <>
          <TranscriptView entries={snapshot.entries} className="flex-1" />
          <Composer
            running={snapshot.running}
            aborting={snapshot.aborting}
            onSubmit={sendPrompt}
            onAbort={abort}
          />
        </>
      )}
    </div>
  );
}
