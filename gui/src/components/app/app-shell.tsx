import type { SessionsStore } from "@omp-gui/ipc";
import { Button } from "@omp-gui/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@omp-gui/ui/components/empty";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@omp-gui/ui/components/sidebar";
import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { SessionSidebar } from "@gui/components/app/session-sidebar";
import { SessionView } from "@gui/components/session/session-view";
import { useSessions } from "@gui/session/use-sessions";

export interface AppShellProps {
  store: SessionsStore;
}

/**
 * The v1 dispatcher shell (T8, issue #9): a session sidebar next to the
 * active session's view. The app's one `SessionsStore` is threaded down as
 * a prop rather than re-read from router context by every descendant,
 * matching `routes/index.tsx`'s existing convention of resolving context
 * once at the route boundary.
 *
 * A subagent panel (a later 2B ticket) is the remaining documented seam
 * from `sessions-store.ts`'s top-of-file comment: it slots in here as a
 * third child of `SidebarInset`, after `SessionView`, keyed off the same
 * `activeId` this component already tracks.
 */
export function AppShell({ store }: AppShellProps) {
  const { sessions, activeId, createSession, closeSession, selectSession } = useSessions(store);

  return (
    <SidebarProvider className="h-svh">
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        onCreate={createSession}
        onSelect={selectSession}
        onClose={closeSession}
      />
      <SidebarInset>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
          <SidebarTrigger />
        </header>
        {activeId ? (
          <SessionView key={activeId} store={store} sessionId={activeId} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-4">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RobotIcon />
                </EmptyMedia>
                <EmptyTitle>No active session</EmptyTitle>
                <EmptyDescription>Start a session to dispatch work to an agent.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={createSession}>
                  <PlusIcon />
                  New session
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
