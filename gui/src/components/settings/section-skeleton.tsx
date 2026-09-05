/**
 * Loading placeholder for a Settings section (T20, issue #19 story #45):
 * fixed-height rows so the layout never jumps once the real group renders.
 */
import { Skeleton } from "@omp-gui/ui/components/skeleton";

export interface SectionSkeletonProps {
  rows?: number;
}

export function SectionSkeleton({ rows = 4 }: SectionSkeletonProps) {
  return (
    <div className="flex flex-col divide-y divide-border ring-1 ring-foreground/10">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-8 items-center gap-3 px-3">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="ml-auto h-6 w-24" />
        </div>
      ))}
    </div>
  );
}
