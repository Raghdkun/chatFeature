import { Badge } from '@/components/ui/badge';
import { useTrans } from '@/hooks/use-trans';
import type { ConversationStatus } from '@/lib/chat/types';
import { cn } from '@/lib/utils';

const STYLES: Record<ConversationStatus, string> = {
    queued: 'border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
    active: 'border-emerald-300/70 bg-emerald-50 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100',
    ended: 'border-border bg-muted text-muted-foreground',
    closed: 'border-border bg-muted text-muted-foreground',
    missed: 'border-red-300/70 bg-red-50 text-red-950 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-100',
};

/** The conversation's status as a word with a tint (the word is always there: colour alone never carries the meaning). */
export function StatusBadge({
    status,
    className,
}: {
    status: ConversationStatus;
    className?: string;
}) {
    const { t } = useTrans();

    return (
        <Badge
            variant="outline"
            data-status={status}
            className={cn('font-medium', STYLES[status], className)}
        >
            {t(`inbox.status.${status}`)}
        </Badge>
    );
}
