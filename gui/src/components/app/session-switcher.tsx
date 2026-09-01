import { useState } from "react";
import type {
  SessionDirectory,
  SessionFileEntry,
  SessionPreview,
  SessionsStore,
} from "@omp-gui/ipc";
import { Alert, AlertDescription } from "@omp-gui/ui/components/alert";
import { Button } from "@omp-gui/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@omp-gui/ui/components/dialog";
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
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@omp-gui/ui/components/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@omp-gui/ui/components/sheet";
import { SidebarMenuButton } from "@omp-gui/ui/components/sidebar";
import { Spinner } from "@omp-gui/ui/components/spinner";
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ClockCounterClockwiseIcon,
  EyeIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { useSessionDirectory, useSessionOwnership } from "@gui/session/use-session-directory";

export interface SessionSwitcherProps {
  store: SessionsStore;
}

/** Renders `Math.round(seconds-ago)` bucketed into the coarsest unit that
 * keeps the count under ~60, matching the compact style already used for
 * session status labels elsewhere in this sidebar. */
function formatRelativeTime(epochSeconds: number): string {
  const diffSeconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.round(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.round(diffMonths / 12)}y ago`;
}

/** Picks the largest byte unit that keeps the displayed value under 1024,
 * capping at GB (session transcripts never approach TB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

interface SessionSwitcherRowProps {
  directory: SessionDirectory;
  entry: SessionFileEntry;
  onResumed: (sessionId: string) => void;
}

/**
 * One past-session row: a Resume action, or — once guarded, either because
 * `ownerOf` already reports this app driving it or because a prior resume
 * attempt was refused — a read-only-replay affordance instead (ADR-0005).
 */
function SessionSwitcherRow({ directory, entry, onResumed }: SessionSwitcherRowProps) {
  const ownership = useSessionOwnership(directory, entry.path);
  const [resuming, setResuming] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);

  const guarded = ownership.state !== "free" || refusal !== null;
  const title = entry.title ?? "(untitled session)";

  async function handleResume(): Promise<void> {
    setResuming(true);
    setRefusal(null);
    try {
      const result = await directory.resume(entry.path);
      if (result.ok) {
        onResumed(result.sessionId);
      } else {
        setRefusal(result.reason);
      }
    } finally {
      setResuming(false);
    }
  }

  async function handlePreview(): Promise<void> {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await directory.preview(entry.path));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        {guarded ? <LockSimpleIcon /> : <ClockCounterClockwiseIcon />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>
          {entry.cwd || "unknown directory"} · {formatRelativeTime(entry.modifiedAt)} ·{" "}
          {formatBytes(entry.sizeBytes)}
        </ItemDescription>
        {guarded && (
          <ItemDescription className="text-destructive">
            {refusal ?? "Currently open in this app"}
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        {guarded ? (
          <Button variant="outline" size="sm" onClick={() => void handlePreview()}>
            <EyeIcon />
            Read-only
          </Button>
        ) : (
          <Button size="sm" onClick={() => void handleResume()} disabled={resuming}>
            {resuming ? <Spinner /> : <ArrowRightIcon />}
            Resume
          </Button>
        )}
      </ItemActions>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Read-only replay — {entry.cwd || "unknown directory"}
            </DialogDescription>
          </DialogHeader>
          {previewLoading && (
            <div className="flex items-center justify-center py-6">
              <Spinner />
            </div>
          )}
          {previewError && (
            <Alert variant="destructive">
              <AlertDescription>{previewError}</AlertDescription>
            </Alert>
          )}
          {preview && (
            <div className="flex flex-col gap-3">
              {preview.messages.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No messages found in the scanned portion of this session.
                </p>
              ) : (
                preview.messages.map((message, index) => (
                  <div key={index} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground capitalize">
                      {message.role}
                    </span>
                    <p className="text-xs/relaxed whitespace-pre-wrap">{message.text}</p>
                  </div>
                ))
              )}
              {preview.truncated && (
                <p className="text-xs text-muted-foreground">
                  More messages exist beyond this preview.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Item>
  );
}

/**
 * Past-sessions switcher (T7, issue #8): a sidebar-triggered sheet listing
 * session files found on disk, with a resume action per entry and a
 * read-only-replay affordance for files ADR-0005's single-writer guard
 * refuses to drive.
 */
export function SessionSwitcher({ store }: SessionSwitcherProps) {
  const { directory, entries, refreshing, refresh } = useSessionDirectory(store);
  const [open, setOpen] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (nextOpen) void refresh();
  }

  function handleResumed(sessionId: string): void {
    store.selectSession(sessionId);
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger
        render={
          <SidebarMenuButton>
            <ClockCounterClockwiseIcon />
            <span>Browse past sessions</span>
          </SidebarMenuButton>
        }
      />
      <SheetContent className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Past sessions</SheetTitle>
          <SheetDescription>
            Sessions found on disk, newest first. Resume one to continue it, or view a guarded one
            read-only.
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between px-4">
          <span className="text-xs text-muted-foreground">
            {entries.length} session{entries.length === 1 ? "" : "s"}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh past sessions"
          >
            <ArrowClockwiseIcon className={refreshing ? "animate-spin" : undefined} />
          </Button>
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
          {entries.length === 0 ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ClockCounterClockwiseIcon />
                </EmptyMedia>
                <EmptyTitle className="text-xs">No past sessions</EmptyTitle>
                <EmptyDescription className="text-xs">
                  Sessions you've run before will show up here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup>
              {entries.map((entry) => (
                <SessionSwitcherRow
                  key={entry.path}
                  directory={directory}
                  entry={entry}
                  onResumed={handleResumed}
                />
              ))}
            </ItemGroup>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
