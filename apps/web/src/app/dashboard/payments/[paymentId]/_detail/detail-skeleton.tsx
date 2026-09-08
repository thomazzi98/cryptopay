import { Card, Skeleton } from '@/components/ui/surfaces';

/** Shaped like the screen it stands in for, so nothing jumps when the payment lands. */
export function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <Skeleton className="h-7 w-32 rounded-full" />
          <Skeleton className="h-7 w-44" />
          <div className="flex-1" />
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="grid gap-5 border-t border-border px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (unused, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="grid gap-5 px-5 py-5 sm:grid-cols-[1fr_16rem]">
          <div className="space-y-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-36" />
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex gap-2 border-b border-border px-4 py-3">
          {Array.from({ length: 4 }, (unused, index) => (
            <Skeleton key={index} className="h-5 w-20" />
          ))}
        </div>
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }, (unused, index) => (
            <Skeleton key={index} className="h-11 w-full" />
          ))}
        </div>
      </Card>
    </div>
  );
}
