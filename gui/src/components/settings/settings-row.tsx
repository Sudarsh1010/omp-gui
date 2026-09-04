/**
 * One 32px Settings row (T20, issue #19/#20; the shared primitive every
 * later ticket's rows use — never redefined): label + description on the
 * left, the control on the right, the key path in mono revealed on hover,
 * a stone (never emerald — the Two-Signals Rule reserves emerald for
 * agent-working/succeeded) "modified" dot, and an inline save-status
 * indicator beside the control instead of a toast (issue #19 story #10).
 */
import type { ReactNode } from "react";

export type RowStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "rejected"; message: string };

export interface SettingsRowProps {
  /** Stable identifier for this row, unique within its section — becomes
   * `data-settings-row` and `id="row-<rowKey>"`, the scroll-highlight
   * anchor search results (#28) navigate to. */
  rowKey: string;
  label: string;
  description?: string;
  /** The underlying config key path, e.g. `browser.chromiumPath` — shown
   * in mono on hover only, never always-visible (issue #19 "Row shape"). */
  keyPath?: string;
  /** True when the value differs from its default. Renders a stone dot —
   * never emerald, per the Two-Signals Rule. */
  modified?: boolean;
  status?: RowStatus;
  children: ReactNode;
}

export function SettingsRow({
  rowKey,
  label,
  description,
  keyPath,
  modified,
  status,
  children,
}: SettingsRowProps) {
  return (
    <div
      data-settings-row={rowKey}
      id={`row-${rowKey}`}
      className="group flex min-h-8 items-center justify-between gap-4 px-3 py-2"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          {modified && (
            <span
              aria-hidden
              title="Differs from default"
              className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
            />
          )}
          {keyPath && (
            <span className="hidden font-mono text-[10px] text-muted-foreground group-hover:inline">
              {keyPath}
            </span>
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <RowStatusIndicator status={status} />
        {children}
      </div>
    </div>
  );
}

function RowStatusIndicator({ status }: { status: RowStatus | undefined }) {
  if (!status || status.kind === "idle" || status.kind === "saving") return null;
  if (status.kind === "saved") {
    return <span className="text-xs text-muted-foreground">Saved</span>;
  }
  return (
    <span className="bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">{status.message}</span>
  );
}
