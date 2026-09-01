import type { DiffLine, FileDiff } from "@omp-gui/ipc";
import { cn } from "@omp-gui/ui/lib/utils";

/**
 * Renders reconstructed edit-tool diffs inline (protocol notes §4.1: there is
 * no dedicated diff event, so `Transcript` parses the tool result's unified
 * diff text into structured lines itself — this component only colors them).
 * One block per file, so multi-file edit turns show a diff per file.
 *
 * `@omp-gui/ui` has no code/diff primitive, so this is built from bare
 * Tailwind utilities, matching `ToolExecutionView`'s existing raw `<pre>`
 * payload rendering rather than inventing a second convention.
 */
export function DiffView({ diffs }: { diffs: FileDiff[] }) {
  return (
    <div className="flex flex-col gap-2">
      {diffs.map((file, index) => (
        <FileDiffBlock key={file.path ?? index} file={file} />
      ))}
    </div>
  );
}

function FileDiffBlock({ file }: { file: FileDiff }) {
  return (
    <div className="overflow-hidden border border-border">
      {file.path && (
        <div className="border-b border-border bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {file.path}
        </div>
      )}
      <pre className="max-h-64 overflow-auto p-0 font-mono text-[11px] leading-5 whitespace-pre-wrap">
        {file.lines.map((line, index) => (
          <DiffLineRow key={index} line={line} />
        ))}
      </pre>
    </div>
  );
}

const DIFF_LINE_MARKER: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
  hunk: "",
  other: "",
};

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.kind === "hunk") {
    return <div className="bg-muted px-2 text-muted-foreground">{line.content}</div>;
  }
  return (
    <div
      className={cn(
        "px-2",
        line.kind === "add" && "bg-success/10 text-success",
        line.kind === "remove" && "bg-destructive/10 text-destructive",
        (line.kind === "context" || line.kind === "other") && "text-foreground/80",
      )}
    >
      <span className="mr-1 select-none opacity-60">{DIFF_LINE_MARKER[line.kind]}</span>
      {line.content}
    </div>
  );
}
