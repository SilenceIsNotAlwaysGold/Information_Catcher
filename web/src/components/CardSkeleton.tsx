import { Skeleton } from "@nextui-org/skeleton";

export function CardSkeleton({
  cards = 6,
  cols = 3,
}: {
  cards?: number;
  cols?: number;
}) {
  const colClass =
    cols === 2 ? "grid-cols-1 sm:grid-cols-2" :
    cols === 4 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" :
    "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return (
    <div className={`grid ${colClass} gap-4 p-4`}>
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-default-200 p-4">
          <Skeleton className="h-5 w-3/5 rounded-lg" />
          <Skeleton className="h-3 w-4/5 rounded-lg" />
          <Skeleton className="h-3 w-2/3 rounded-lg" />
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-6 w-16 rounded-md" />
            <Skeleton className="h-6 w-16 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
