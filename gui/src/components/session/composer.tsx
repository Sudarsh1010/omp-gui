import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { QueueDrainMode, SteeringInterruptMode, SteeringSnapshot } from "@omp-gui/ipc";
import { Badge } from "@omp-gui/ui/components/badge";
import { Button } from "@omp-gui/ui/components/button";
import { ButtonGroup } from "@omp-gui/ui/components/button-group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@omp-gui/ui/components/input-group";
import { Label } from "@omp-gui/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@omp-gui/ui/components/select";
import {
  ArrowUUpRightIcon,
  PaperPlaneRightIcon,
  QueueIcon,
  SteeringWheelIcon,
  StopIcon,
} from "@phosphor-icons/react";

/**
 * The steering half of `ComposerProps` (T5, issue #6): the live queue-mode
 * values, queue depth, and per-action pending/error state from
 * `@omp-gui/ipc`'s `SteeringController`, plus the actions the composer's
 * steering affordances dispatch back into it. Grouped separately from the
 * pre-existing prompt/abort props so `SessionView`'s wiring stays a single
 * added prop line.
 */
export interface ComposerSteeringProps {
  snapshot: SteeringSnapshot;
  /** Inject the composer's current text into the running turn. */
  onSteer: (text: string) => void;
  /** Queue the composer's current text to run after the turn completes,
   * under the follow-up queue-mode picker's current selection. */
  onFollowUp: (text: string, queueMode: QueueDrainMode) => void;
  /** Abort the running turn and submit the composer's current text as a
   * new prompt, in one action. */
  onAbortAndPrompt: (text: string) => void;
  onSetSteeringMode: (mode: QueueDrainMode) => void;
  onSetFollowUpMode: (mode: QueueDrainMode) => void;
  onSetInterruptMode: (mode: SteeringInterruptMode) => void;
}

export interface ComposerProps {
  /** True from turn start until the run's terminal completion. */
  running: boolean;
  /** True while an abort command is in flight. */
  aborting: boolean;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  steering: ComposerSteeringProps;
}

/**
 * Textarea + send button; Enter submits, Shift+Enter inserts a newline.
 * While a turn is running, Send is replaced by Steer (Enter also does
 * this — protocol.md §2.2: a message submitted while already streaming
 * defaults to steering), Follow up (queued under the follow-up picker's
 * mode), and Abort & Prompt, alongside the pre-existing Abort button,
 * whose own behavior is unchanged. The three queue-mode pickers
 * (steering/follow-up/interrupt, protocol.md §2.6) are always visible so
 * they can be set ahead of needing them.
 */
export function Composer({ running, aborting, onSubmit, onAbort, steering }: ComposerProps) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const { snapshot } = steering;

  const submit = () => {
    if (!trimmed) return;
    if (running) {
      steering.onSteer(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setText("");
  };

  const followUp = () => {
    if (!trimmed) return;
    steering.onFollowUp(trimmed, snapshot.queueModes.followUpMode);
    setText("");
  };

  const abortAndPrompt = () => {
    if (!trimmed) return;
    steering.onAbortAndPrompt(trimmed);
    setText("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  return (
    <form onSubmit={handleSubmit}>
      <InputGroup>
        <InputGroupAddon
          align="block-start"
          className="flex-wrap gap-x-4 gap-y-1.5 border-b border-border"
        >
          <Label>
            Steering
            <Select<QueueDrainMode>
              value={snapshot.queueModes.steeringMode}
              onValueChange={(mode) => mode && steering.onSetSteeringMode(mode)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one-at-a-time">One at a time</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <Label>
            Follow-up
            <Select<QueueDrainMode>
              value={snapshot.queueModes.followUpMode}
              onValueChange={(mode) => mode && steering.onSetFollowUpMode(mode)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one-at-a-time">One at a time</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <Label>
            Interrupt
            <Select<SteeringInterruptMode>
              value={snapshot.queueModes.interruptMode}
              onValueChange={(mode) => mode && steering.onSetInterruptMode(mode)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="immediate">Immediate</SelectItem>
                <SelectItem value="wait">Wait for turn</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {snapshot.queuedMessageCount > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {snapshot.queuedMessageCount} queued
            </Badge>
          )}
        </InputGroupAddon>
        <InputGroupTextarea
          placeholder={running ? "Steer, follow up, or abort & prompt…" : "Message the agent…"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="block-end">
          {running ? (
            <>
              <ButtonGroup>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={submit}
                  disabled={!trimmed || snapshot.pending.steer}
                >
                  <SteeringWheelIcon />
                  Steer
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={followUp}
                  disabled={!trimmed || snapshot.pending.followUp}
                >
                  <QueueIcon />
                  Follow up
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={abortAndPrompt}
                  disabled={!trimmed || snapshot.pending.abortAndPrompt}
                >
                  <ArrowUUpRightIcon />
                  Abort &amp; Prompt
                </Button>
              </ButtonGroup>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onAbort}
                disabled={aborting}
                className="ml-auto"
              >
                <StopIcon />
                {aborting ? "Aborting…" : "Abort"}
              </Button>
            </>
          ) : (
            <InputGroupButton
              type="submit"
              variant="default"
              size="sm"
              disabled={!trimmed}
              className="ml-auto"
            >
              <PaperPlaneRightIcon />
              Send
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {snapshot.lastError && <p className="mt-1 text-xs text-destructive">{snapshot.lastError}</p>}
    </form>
  );
}
