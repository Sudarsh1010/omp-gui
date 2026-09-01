import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { ApprovalAnswer, ApprovalRequest, SessionsStore } from "@omp-gui/ipc";
import { Badge } from "@omp-gui/ui/components/badge";
import { Button } from "@omp-gui/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@omp-gui/ui/components/card";
import { Input } from "@omp-gui/ui/components/input";
import { Textarea } from "@omp-gui/ui/components/textarea";
import {
  BellRingingIcon,
  CheckIcon,
  ListBulletsIcon,
  NotePencilIcon,
  TextAaIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useApprovalNotifications } from "@gui/session/use-approval-notifications";
import { useApprovalInbox } from "@gui/session/use-approvals";

export interface ApprovalInboxProps {
  store: SessionsStore;
  sessionId: string;
}

const METHOD_ICON = {
  select: ListBulletsIcon,
  confirm: CheckIcon,
  input: TextAaIcon,
  editor: NotePencilIcon,
} as const;

const METHOD_LABEL: Record<ApprovalRequest["method"], string> = {
  select: "Select",
  confirm: "Confirm",
  input: "Input",
  editor: "Editor",
};

/**
 * The queued triage list for one session's blocking `extension_ui_request`
 * prompts (T4, issue #5) — rendered inline, never as a modal (`gui/
 * CONTEXT.md`'s "Approval" entry explicitly avoids "permission dialog,
 * confirmation popup": the whole point of an inbox is that several
 * prompts can queue and get triaged in one flow instead of stealing
 * focus). Renders nothing when the queue is empty.
 *
 * Also mounts the cross-session OS-notification wiring (`use-approval-
 * notifications.ts`) here, since this is "where the inbox lives" for
 * whichever session is currently active — the underlying registry it
 * subscribes through keeps tracking every session regardless.
 */
export function ApprovalInbox({ store, sessionId }: ApprovalInboxProps) {
  useApprovalNotifications(store);
  const { pending, answer } = useApprovalInbox(store, sessionId);

  if (pending.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BellRingingIcon />
        Approvals
        <Badge variant="secondary">{pending.length}</Badge>
      </div>
      {pending.map(({ request }) => (
        <ApprovalCard
          key={request.id}
          request={request}
          onAnswer={(response) => answer(request.id, response)}
        />
      ))}
    </div>
  );
}

interface ApprovalCardProps {
  request: ApprovalRequest;
  onAnswer: (answer: ApprovalAnswer) => void;
}

function ApprovalCard({ request, onAnswer }: ApprovalCardProps) {
  const Icon = METHOD_ICON[request.method];
  return (
    <Card size="sm" className="ring-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Icon />
          {request.title}
        </CardTitle>
        <CardAction>
          <Badge variant="outline">{METHOD_LABEL[request.method]}</Badge>
        </CardAction>
        {request.method === "confirm" && <CardDescription>{request.message}</CardDescription>}
      </CardHeader>
      <CardContent>
        {request.method === "confirm" ? (
          <ConfirmControls onAnswer={onAnswer} />
        ) : request.method === "select" ? (
          <SelectControls request={request} onAnswer={onAnswer} />
        ) : request.method === "input" ? (
          <InputControls request={request} onAnswer={onAnswer} />
        ) : (
          <EditorControls request={request} onAnswer={onAnswer} />
        )}
      </CardContent>
    </Card>
  );
}

function ConfirmControls({ onAnswer }: { onAnswer: (answer: ApprovalAnswer) => void }) {
  return (
    <div className="flex gap-2">
      <Button
        variant="default"
        size="sm"
        onClick={() => onAnswer({ method: "confirm", confirmed: true })}
      >
        <CheckIcon />
        Approve
      </Button>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => onAnswer({ method: "confirm", confirmed: false })}
      >
        <XIcon />
        Deny
      </Button>
    </div>
  );
}

function SelectControls({
  request,
  onAnswer,
}: {
  request: Extract<ApprovalRequest, { method: "select" }>;
  onAnswer: (answer: ApprovalAnswer) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {request.options.map((option, index) => {
        const description = request.optionDetails?.[index]?.description;
        return (
          <Button
            key={option}
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => onAnswer({ method: "select", value: option })}
          >
            <span className="flex-1 text-left">{option}</span>
            {description ? <span className="text-muted-foreground">{description}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}

function InputControls({
  request,
  onAnswer,
}: {
  request: Extract<ApprovalRequest, { method: "input" }>;
  onAnswer: (answer: ApprovalAnswer) => void;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onAnswer({ method: "input", value });
  };

  return (
    <form className="flex gap-2" onSubmit={handleSubmit}>
      <Input
        autoFocus
        placeholder={request.placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="sm">
        <CheckIcon />
        Send
      </Button>
    </form>
  );
}

function EditorControls({
  request,
  onAnswer,
}: {
  request: Extract<ApprovalRequest, { method: "editor" }>;
  onAnswer: (answer: ApprovalAnswer) => void;
}) {
  const [value, setValue] = useState(request.prefill ?? "");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onAnswer({ method: "editor", value });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      onAnswer({ method: "editor", value });
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <Textarea
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <Button type="submit" size="sm" className="self-end">
        <CheckIcon />
        Submit
      </Button>
    </form>
  );
}
