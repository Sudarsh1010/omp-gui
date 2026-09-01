import { useEffect, useState } from "react";
import type {
  SessionsStore,
  SubagentMessageEntry,
  SubagentNoticeEntry,
  SubagentStatus,
  SubagentStreamEntry,
  SubagentSummary,
  SubagentThinkingEntry,
  SubagentToolEntry,
  SubagentToolStatus,
} from "@omp-gui/ipc";
import { Alert, AlertDescription, AlertTitle } from "@omp-gui/ui/components/alert";
import { Badge } from "@omp-gui/ui/components/badge";
import { Bubble, BubbleContent } from "@omp-gui/ui/components/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@omp-gui/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@omp-gui/ui/components/item";
import { Message, MessageContent, MessageHeader } from "@omp-gui/ui/components/message";
import { ScrollArea } from "@omp-gui/ui/components/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@omp-gui/ui/components/sheet";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { cn } from "@omp-gui/ui/lib/utils";
import {
  BrainIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  InfoIcon,
  TreeStructureIcon,
  WarningCircleIcon,
  WarningIcon,
  WrenchIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useSubagentStream, useSubagentSummaries } from "@gui/session/use-subagents";

export interface SubagentPanelProps {
  store: SessionsStore;
  sessionId: string | null;
}

const STATUS_LABEL: Record<SubagentStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
};

const STATUS_ICON: Record<SubagentStatus, typeof CircleIcon> = {
  pending: CircleIcon,
  running: CircleNotchIcon,
  completed: CheckCircleIcon,
  failed: WarningCircleIcon,
  aborted: XCircleIcon,
};

const STATUS_ICON_CLASS: Record<SubagentStatus, string> = {
  pending: "text-muted-foreground",
  running: "animate-spin text-primary",
  completed: "text-emerald-600 dark:text-emerald-500",
  failed: "text-destructive",
  aborted: "text-muted-foreground",
};

const STATUS_BADGE_VARIANT: Record<SubagentStatus, "secondary" | "outline" | "destructive"> = {
  pending: "outline",
  running: "secondary",
  completed: "outline",
  failed: "destructive",
  aborted: "outline",
};

/** One-line live status for a roster row: the current tool call, else the
 * last free-text intent, else falls back to the static assignment/task the
 * subagent was spawned with. */
function statusLine(summary: SubagentSummary): string {
  const progress = summary.progress;
  if (progress?.currentTool) return `Running ${progress.currentTool}`;
  if (progress?.lastIntent) return progress.lastIntent;
  return summary.description ?? summary.task ?? summary.assignment ?? "Working…";
}

/**
 * Subagent panel (T12, issue #13; ADR-0002 rationale — delegated `task`-tool
 * work should be observable, not a black box). Docks below the active
 * session's transcript (the "third child of SidebarInset" seam documented
 * in `sessions-store.ts`'s top-of-file comment) with a live roster; a row
 * click drills into that subagent's own message stream in a side sheet.
 *
 * `SubagentTracker` (behind `useSubagentSummaries`/`useSubagentStream`)
 * already tracks every session's subagents regardless of mount state, so
 * this component only ever *reads* — switching the active session or
 * unmounting this panel never drops anything the tracker saw.
 */
export function SubagentPanel({ store, sessionId }: SubagentPanelProps) {
  const summaries = useSubagentSummaries(store, sessionId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A drill-in left open across a session switch would silently show a
  // different session's subagent under the old one's id.
  useEffect(() => {
    setSelectedId(null);
  }, [sessionId]);

  if (!sessionId) return null;

  const selected = summaries.find((summary) => summary.id === selectedId) ?? null;

  return (
    <div className="flex max-h-56 shrink-0 flex-col border-t border-border">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <TreeStructureIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Subagents</span>
        {summaries.length > 0 && <Badge variant="secondary">{summaries.length}</Badge>}
      </div>

      {summaries.length === 0 ? (
        <Empty className="py-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TreeStructureIcon />
            </EmptyMedia>
            <EmptyTitle className="text-xs">No subagents yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Delegated task-tool work will show up here as it spawns.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1.5 p-2">
            {summaries.map((summary) => (
              <SubagentRow
                key={summary.id}
                summary={summary}
                onSelect={() => setSelectedId(summary.id)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg">
          <SheetHeader className="shrink-0 border-b border-border">
            <SheetTitle>{selected ? `${selected.agent} #${selected.index}` : "Subagent"}</SheetTitle>
            <SheetDescription>
              {selected?.description ?? selected?.task ?? selected?.assignment ?? ""}
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <SubagentStreamPanel store={store} sessionId={sessionId} subagentId={selected.id} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SubagentRow({
  summary,
  onSelect,
}: {
  summary: SubagentSummary;
  onSelect: () => void;
}) {
  const StatusIcon = STATUS_ICON[summary.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group/item flex w-full items-center gap-2.5 border border-border px-3 py-2 text-left text-xs transition-colors hover:bg-muted focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ItemMedia>
        <StatusIcon weight="fill" className={cn("size-3.5", STATUS_ICON_CLASS[summary.status])} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {summary.agent} <span className="text-muted-foreground">#{summary.index}</span>
        </ItemTitle>
        <ItemDescription>{statusLine(summary)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {summary.progress && summary.progress.toolCount > 0 && (
          <Badge variant="outline">{summary.progress.toolCount} calls</Badge>
        )}
        <Badge variant={STATUS_BADGE_VARIANT[summary.status]}>
          {summary.status === "running" && <Spinner className="size-3" />}
          {STATUS_LABEL[summary.status]}
        </Badge>
        <CaretRightIcon className="size-3.5 text-muted-foreground" />
      </ItemActions>
    </button>
  );
}

function SubagentStreamPanel({
  store,
  sessionId,
  subagentId,
}: {
  store: SessionsStore;
  sessionId: string;
  subagentId: string;
}) {
  const stream = useSubagentStream(store, sessionId, subagentId);

  if (stream.length === 0) {
    return (
      <Empty className="flex-1 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChatCircleDotsIcon />
          </EmptyMedia>
          <EmptyTitle className="text-xs">No activity yet</EmptyTitle>
          <EmptyDescription className="text-xs">
            Waiting for the subagent's first message.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-3">
        {stream.map((entry) => (
          <SubagentStreamEntryView key={entry.id} entry={entry} />
        ))}
      </div>
    </ScrollArea>
  );
}

function SubagentStreamEntryView({ entry }: { entry: SubagentStreamEntry }) {
  switch (entry.kind) {
    case "message":
      return <SubagentMessageView entry={entry} />;
    case "thinking":
      return <SubagentThinkingView entry={entry} />;
    case "tool":
      return <SubagentToolView entry={entry} />;
    case "notice":
      return <SubagentNoticeView entry={entry} />;
    default:
      return null;
  }
}

const ROLE_LABEL: Record<SubagentMessageEntry["role"], string> = {
  user: "Task",
  developer: "System",
  assistant: "Assistant",
};

function SubagentMessageView({ entry }: { entry: SubagentMessageEntry }) {
  const align = entry.role === "assistant" ? "start" : "end";
  return (
    <Message align={align}>
      <MessageContent>
        <MessageHeader>{ROLE_LABEL[entry.role]}</MessageHeader>
        <Bubble align={align} variant={entry.role === "assistant" ? "secondary" : "default"}>
          <BubbleContent className="whitespace-pre-wrap">
            {entry.text}
            {entry.streaming && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-text-bottom"
              />
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function SubagentThinkingView({ entry }: { entry: SubagentThinkingEntry }) {
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>
          <BrainIcon className="size-3.5" />
          Thinking
        </MessageHeader>
        <Bubble align="start" variant="outline">
          <BubbleContent className="whitespace-pre-wrap text-muted-foreground italic">
            {entry.text}
            {entry.streaming && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-text-bottom"
              />
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

const TOOL_STATUS_LABEL: Record<SubagentToolStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Error",
  aborted: "Aborted",
};

const TOOL_STATUS_BADGE_VARIANT: Record<
  SubagentToolStatus,
  "secondary" | "outline" | "destructive"
> = {
  running: "secondary",
  done: "outline",
  error: "destructive",
  aborted: "outline",
};

function SubagentToolView({ entry }: { entry: SubagentToolEntry }) {
  return (
    <Item variant="outline" size="sm">
      <ItemMedia>
        <WrenchIcon className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{entry.toolName}</ItemTitle>
        {entry.intent && <ItemDescription>{entry.intent}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        <Badge variant={TOOL_STATUS_BADGE_VARIANT[entry.status]}>
          {entry.status === "running" && <Spinner className="size-3" />}
          {TOOL_STATUS_LABEL[entry.status]}
        </Badge>
      </ItemActions>
    </Item>
  );
}

function SubagentNoticeView({ entry }: { entry: SubagentNoticeEntry }) {
  const Icon = entry.level === "info" ? InfoIcon : WarningIcon;
  return (
    <Alert variant={entry.level === "info" ? "default" : "destructive"}>
      <Icon />
      <AlertTitle>{entry.level}</AlertTitle>
      <AlertDescription>{entry.message}</AlertDescription>
    </Alert>
  );
}
