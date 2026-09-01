import type {
  AssistantMessageEntry,
  NoticeEntry,
  ThinkingEntry,
  ToolExecutionEntry,
  ToolExecutionStatus,
  TranscriptEntry,
  UserMessageEntry,
} from "@omp-gui/ipc";
import { Message, MessageContent, MessageHeader } from "@omp-gui/ui/components/message";
import { Bubble, BubbleContent } from "@omp-gui/ui/components/bubble";
import { Alert, AlertDescription, AlertTitle } from "@omp-gui/ui/components/alert";
import { Badge } from "@omp-gui/ui/components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemHeader,
  ItemMedia,
  ItemTitle,
} from "@omp-gui/ui/components/item";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { BrainIcon, InfoIcon, WarningIcon, WrenchIcon } from "@phosphor-icons/react";

/** Dispatches one transcript entry to its kind-specific renderer. Consumes
 * only the `@omp-gui/ipc` transcript-core types — no protocol parsing here. */
export function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "user":
      return <UserMessageView entry={entry} />;
    case "assistant":
      return <AssistantMessageView entry={entry} />;
    case "thinking":
      return <ThinkingView entry={entry} />;
    case "tool":
      return <ToolExecutionView entry={entry} />;
    case "notice":
      return <NoticeView entry={entry} />;
    default:
      return null;
  }
}

function UserMessageView({ entry }: { entry: UserMessageEntry }) {
  return (
    <Message align="end">
      <MessageContent>
        <MessageHeader>{entry.synthetic ? "omp" : "You"}</MessageHeader>
        <Bubble align="end" variant="default">
          <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function AssistantMessageView({ entry }: { entry: AssistantMessageEntry }) {
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>Assistant</MessageHeader>
        <Bubble align="start" variant="secondary">
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

function ThinkingView({ entry }: { entry: ThinkingEntry }) {
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

const TOOL_STATUS_LABEL: Record<ToolExecutionStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Error",
  aborted: "Aborted",
};

const TOOL_STATUS_BADGE_VARIANT: Record<
  ToolExecutionStatus,
  "secondary" | "outline" | "destructive"
> = {
  running: "secondary",
  done: "outline",
  error: "destructive",
  aborted: "outline",
};

function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Tool executions render as a bordered card, not a chat bubble — a
 * deliberately different visual language so they read as distinct from
 * message/thinking entries at a glance. */
function ToolExecutionView({ entry }: { entry: ToolExecutionEntry }) {
  const payload = entry.result ?? entry.partialResult;
  const payloadText = !entry.diff && payload !== undefined ? formatPayload(payload) : "";
  return (
    <Item variant="outline" size="sm" className="flex-col items-stretch gap-2">
      <ItemHeader>
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
      </ItemHeader>
      {entry.args !== undefined && (
        <pre className="max-h-40 overflow-auto border border-border bg-muted p-2 text-[11px]">
          {formatPayload(entry.args)}
        </pre>
      )}
      {entry.diff ? (
        <pre className="max-h-64 overflow-auto border border-border bg-muted p-2 font-mono text-[11px]">
          {entry.diff}
        </pre>
      ) : (
        payloadText && (
          <pre className="max-h-40 overflow-auto border border-border bg-muted p-2 text-[11px]">
            {payloadText}
          </pre>
        )
      )}
    </Item>
  );
}

function NoticeView({ entry }: { entry: NoticeEntry }) {
  const Icon = entry.level === "info" ? InfoIcon : WarningIcon;
  return (
    <Alert variant={entry.level === "info" ? "default" : "destructive"}>
      <Icon />
      <AlertTitle>{entry.source ? `${entry.source}: ${entry.level}` : entry.level}</AlertTitle>
      <AlertDescription>{entry.message}</AlertDescription>
    </Alert>
  );
}
