import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * A styled native `<select>`. Long lists (400+ time zones) are better served by the
 * platform picker than by a custom popover: type-to-search, mobile wheels, form posts.
 */
export function NativeSelect({
    className,
    children,
    ...props
}: ComponentProps<'select'>) {
    return (
        <div className="relative">
            <select
                data-slot="native-select"
                className={cn(
                    'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-background ps-3 pe-9 text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm dark:bg-input/30',
                    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
                    className,
                )}
                {...props}
            >
                {children}
            </select>
            <ChevronDown
                className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
            />
        </div>
    );
}
