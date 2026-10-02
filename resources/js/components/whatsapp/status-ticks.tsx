import { AlertCircle, Check, CheckCheck, Clock } from 'lucide-react';
import { useTrans } from '@/hooks/use-trans';
import type { WaMessageStatus } from '@/lib/whatsapp/types';
import { cn } from '@/lib/utils';

/**
 * The delivery state of a reply as ticks (and words for assistive tech): a clock while it is being handed over, one tick sent, two ticks
 * delivered, two accent ticks read, an alert when it failed. A customer's message (`received`) has none.
 */
export function StatusTicks({
    status,
    testId,
}: {
    status: WaMessageStatus;
    testId?: string;
}) {
    const { t } = useTrans();

    if (status === 'received') {
        return null;
    }

    return (
        <span
            data-testid={testId}
            data-status={status}
            className={cn(
                'inline-flex items-center',
                status === 'read' && 'text-primary',
                status === 'failed' && 'text-destructive-foreground',
            )}
        >
            {status === 'pending' ? (
                <Clock className="size-3.5" aria-hidden />
            ) : status === 'failed' ? (
                <AlertCircle className="size-3.5" aria-hidden />
            ) : status === 'sent' ? (
                <Check className="size-3.5" aria-hidden />
            ) : (
                <CheckCheck className="size-3.5" aria-hidden />
            )}
            <span className="sr-only">
                {t(`whatsapp.message.status.${status}`)}
            </span>
        </span>
    );
}
