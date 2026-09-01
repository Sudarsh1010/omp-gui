import type { SessionsStore } from "@omp-gui/ipc";
import { Alert, AlertDescription, AlertTitle } from "@omp-gui/ui/components/alert";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@omp-gui/ui/components/tabs";
import { ChatCircleDotsIcon, GlobeIcon, WarningIcon } from "@phosphor-icons/react";
import { ApprovalInbox } from "@gui/components/session/approval-inbox";
import { Composer } from "@gui/components/session/composer";
import { LoginPanel } from "@gui/components/session/login-panel";
import { ModelPicker } from "@gui/components/session/model-picker";
import { SessionBrowserPane } from "@gui/components/session/session-browser-pane";
import { TranscriptView } from "@gui/components/session/transcript-view";
import { useSessionSummary, useSessionTranscript } from "@gui/session/use-sessions";
import { useSteering } from "@gui/session/use-steering";

export interface SessionViewProps {
  store: SessionsStore;
  sessionId: string;
}

/**
 * One session's live view: a header (title, model/thinking-level pickers
 * from T13, and the provider-login popover from T14), then either a
 * connecting spinner, a start-failure alert, or a Chat/Browser tab pair —
 * Chat holds the transcript + composer, Browser (T9/T10/T11, issue #1
 * story 18) mounts this session's app-owned Chromium pane, Takeover, and
 * relay toggle, keyed by this same `sessionId` so approval suppression
 * while a human is driving actually attaches to this session.
 *
 * Wired to the `Transcript` the `SessionsStore` already owns for
 * `sessionId` — this component never constructs or disposes one itself, so
 * switching away and back doesn't lose a backgrounded session's history.
 */
export function SessionView({ store, sessionId }: SessionViewProps) {
  const summary = useSessionSummary(store, sessionId);
  const { snapshot, ready, sendPrompt, abort } = useSessionTranscript(store, sessionId);
  const steering = useSteering(store, sessionId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
      <header className="flex shrink-0 items-center justify-between gap-2">
        <h1 className="truncate text-sm font-medium">{summary?.title ?? "Session"}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <ModelPicker store={store} sessionId={sessionId} />
          <LoginPanel store={store} sessionId={sessionId} />
        </div>
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
        <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList>
            <TabsTrigger value="chat">
              <ChatCircleDotsIcon />
              Chat
            </TabsTrigger>
            <TabsTrigger value="browser">
              <GlobeIcon />
              Browser
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col gap-3">
            <ApprovalInbox store={store} sessionId={sessionId} />
            <TranscriptView entries={snapshot.entries} className="flex-1" />
            <Composer
              running={snapshot.running}
              aborting={snapshot.aborting}
              onSubmit={sendPrompt}
              onAbort={abort}
              steering={{
                snapshot: steering.snapshot,
                onSteer: steering.steer,
                onFollowUp: steering.followUp,
                onAbortAndPrompt: steering.abortAndPrompt,
                onSetSteeringMode: steering.setSteeringMode,
                onSetFollowUpMode: steering.setFollowUpMode,
                onSetInterruptMode: steering.setInterruptMode,
              }}
            />
          </TabsContent>
          <TabsContent value="browser" keepMounted className="flex min-h-0 flex-1 flex-col">
            <SessionBrowserPane sessionId={sessionId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
