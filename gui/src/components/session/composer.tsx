import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Button } from "@omp-gui/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@omp-gui/ui/components/input-group";
import { PaperPlaneRightIcon, StopIcon } from "@phosphor-icons/react";

export interface ComposerProps {
  /** True from turn start until the run's terminal completion. */
  running: boolean;
  /** True while an abort command is in flight. */
  aborting: boolean;
  onSubmit: (text: string) => void;
  onAbort: () => void;
}

/** Textarea + send button; Enter submits, Shift+Enter inserts a newline. An
 * Abort button replaces Send while a turn is running (T2 v1 scope: one turn
 * at a time — mid-turn steering/follow-up queueing is a later ticket). */
export function Composer({ running, aborting, onSubmit, onAbort }: ComposerProps) {
  const [text, setText] = useState("");
  const trimmed = text.trim();

  const submit = () => {
    if (!trimmed || running) return;
    onSubmit(trimmed);
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
        <InputGroupTextarea
          placeholder={running ? "Waiting for the agent…" : "Message the agent…"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
        />
        <InputGroupAddon align="block-end">
          {running ? (
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
    </form>
  );
}
