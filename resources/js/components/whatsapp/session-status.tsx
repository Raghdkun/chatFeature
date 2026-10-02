import {
    CircleCheck,
    CircleDashed,
    Loader2,
    QrCode,
    TriangleAlert,
    Unplug,
    type LucideIcon,
} from 'lucide-react';
import { useTrans } from '@/hooks/use-trans';
import type { SessionStatus } from '@/lib/whatsapp/types';
import { cn } from '@/lib/utils';

const TONE: Record<SessionStatus, { icon: LucideIcon; classes: string }> = {
    created: {
        icon: CircleDashed,
        classes: 'border-border bg-muted/60 text-muted-foreground',
    },
    starting: {
        icon: Loader2,
        classes:
            'border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
    },
    qr: {
        icon: QrCode,
        classes:
            'border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
    },
    ready: {
        icon: CircleCheck,
        classes:
            'border-emerald-300/70 bg-emerald-50 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100',
    },
    disconnected: {
        icon: Unplug,
        classes: 'border-border bg-muted/60 text-muted-foreground',
    },
    failed: {
        icon: TriangleAlert,
        classes:
            'border-red-300/70 bg-red-50 text-red-950 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-100',
    },
};

/** A session's state in words, an icon and a tone (never colour alone). */
export function SessionStatusBadge({
    status,
    testId,
    className,
}: {
    status: SessionStatus;
    testId?: string;
    className?: string;
}) {
    const { t } = useTrans();
    const { icon: Icon, classes } = TONE[status];

    return (
        <span
            data-testid={testId}
            data-status={status}
            className={cn(
                'inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
                classes,
                className,
            )}
        >
            <Icon
                className={cn(
                    'size-3.5',
                    status === 'starting' &&
                        'animate-spin motion-reduce:animate-none',
                )}
                aria-hidden
            />
            {t(`whatsapp.status.${status}`)}
        </span>
    );
}
