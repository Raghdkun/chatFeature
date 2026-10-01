import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const LINE_WIDTHS = [
    ['w-2/5', 'w-4/5'],
    ['w-1/3', 'w-3/5'],
    ['w-1/2', 'w-2/3'],
] as const;

/**
 * Faded placeholder rows that show where conversations will appear. Decorative only, so
 * it is hidden from assistive tech and stops pulsing for reduced-motion users.
 */
export function GhostRows({
    count = 3,
    className,
}: {
    count?: number;
    className?: string;
}) {
    return (
        <ul aria-hidden className={cn('grid w-full gap-4', className)}>
            {Array.from({ length: count }, (_, index) => {
                const [title, line] = LINE_WIDTHS[index % LINE_WIDTHS.length];

                return (
                    <li
                        key={index}
                        className="flex items-center gap-3"
                        style={{ opacity: 1 - index * 0.28 }}
                    >
                        <Skeleton className="size-9 shrink-0 rounded-full motion-reduce:animate-none" />
                        <div className="grid flex-1 gap-2">
                            <Skeleton
                                className={cn(
                                    'h-3 motion-reduce:animate-none',
                                    title,
                                )}
                            />
                            <Skeleton
                                className={cn(
                                    'h-3 motion-reduce:animate-none',
                                    line,
                                )}
                            />
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
