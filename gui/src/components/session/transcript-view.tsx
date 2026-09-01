import type { TranscriptEntry } from "@omp-gui/ipc";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@omp-gui/ui/components/message-scroller";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@omp-gui/ui/components/empty";
import { cn } from "@omp-gui/ui/lib/utils";
import { ChatCircleDotsIcon } from "@phosphor-icons/react";
import { TranscriptEntryView } from "@gui/components/session/transcript-entry";

export interface TranscriptViewProps {
  entries: TranscriptEntry[];
  className?: string;
}

/** The live, auto-scrolling transcript list. Renders each entry through
 * `TranscriptEntryView`; ordering is the array order (already the display
 * order — `Transcript` owns that, this component just maps over it). */
export function TranscriptView({ entries, className }: TranscriptViewProps) {
  if (entries.length === 0) {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChatCircleDotsIcon />
          </EmptyMedia>
          <EmptyTitle>No messages yet</EmptyTitle>
          <EmptyDescription>Send a prompt to start the session.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className={cn("min-h-0 flex-1 border border-border", className)}>
        <MessageScrollerViewport>
          <MessageScrollerContent className="px-3 py-4">
            {entries.map((entry, index) => (
              <MessageScrollerItem key={entry.id} scrollAnchor={index === entries.length - 1}>
                <TranscriptEntryView entry={entry} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
