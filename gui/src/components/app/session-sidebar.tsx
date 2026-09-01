import type { SessionStatus, SessionSummary } from "@omp-gui/ipc";
import { Badge } from "@omp-gui/ui/components/badge";
import { Button } from "@omp-gui/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@omp-gui/ui/components/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@omp-gui/ui/components/sidebar";
import { cn } from "@omp-gui/ui/lib/utils";
import {
  CircleIcon,
  CircleNotchIcon,
  PlusIcon,
  StackIcon,
  WarningCircleIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  error: "Error",
  exited: "Exited",
};

const STATUS_ICON: Record<SessionStatus, typeof CircleIcon> = {
  idle: CircleIcon,
  running: CircleNotchIcon,
  error: WarningCircleIcon,
  exited: XCircleIcon,
};

const STATUS_ICON_CLASS: Record<SessionStatus, string> = {
  idle: "text-muted-foreground",
  running: "animate-spin text-primary",
  error: "text-destructive",
  exited: "text-muted-foreground",
};

/**
 * The dispatcher's session list (T8, issue #9): every live session with its
 * status, a switcher (click a row to select it), and a per-row badge slot
 * for approval counts. `SessionSummary.pendingApprovals` is a placeholder
 * T4's approval inbox populates (see `sessions-store.ts`'s top-of-file
 * comment) — this component only renders whatever number it's given.
 */
export function SessionSidebar({ sessions, activeId, onCreate, onSelect, onClose }: SessionSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex flex-row items-center justify-between gap-2 px-2">
        <span className="truncate text-sm font-medium group-data-[collapsible=icon]:hidden">
          Sessions
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onCreate} aria-label="New session">
          <PlusIcon />
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Live sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <StackIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-xs">No sessions yet</EmptyTitle>
                  <EmptyDescription className="text-xs">Start one to dispatch work.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <SidebarMenu>
                {sessions.map((session) => {
                  const StatusIcon = STATUS_ICON[session.status];
                  return (
                    <SidebarMenuItem key={session.id}>
                      <SidebarMenuButton
                        isActive={session.id === activeId}
                        onClick={() => onSelect(session.id)}
                        tooltip={`${session.title} — ${STATUS_LABEL[session.status]}`}
                      >
                        <StatusIcon weight="fill" className={cn("size-3.5", STATUS_ICON_CLASS[session.status])} />
                        <span className="truncate">{session.title}</span>
                        {session.pendingApprovals > 0 && (
                          <Badge variant="destructive" className="ml-auto">
                            {session.pendingApprovals}
                          </Badge>
                        )}
                      </SidebarMenuButton>
                      <SidebarMenuAction
                        showOnHover
                        onClick={() => onClose(session.id)}
                        aria-label={`Close ${session.title}`}
                      >
                        <XIcon />
                      </SidebarMenuAction>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
