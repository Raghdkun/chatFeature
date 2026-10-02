import { NativeSelect } from '@/components/setup/native-select';
import { useTrans } from '@/hooks/use-trans';
import type { PresenceStatus } from '@/lib/chat/types';
import { cn } from '@/lib/utils';

const STATUSES: PresenceStatus[] = ['online', 'away', 'offline'];

/** The status dot: green = takes chats, amber = away (offered chats late), grey = offline. Never the only signal (the label is next to it). */
export function PresenceDot({
    status,
    className,
}: {
    status: PresenceStatus | null;
    className?: string;
}) {
    return (
        <span
            aria-hidden
            data-status={status ?? 'unknown'}
            className={cn(
                'inline-block size-2.5 shrink-0 rounded-full',
                status === 'online' && 'bg-emerald-500',
                status === 'away' && 'bg-amber-500',
                (status === 'offline' || status === null) &&
                    'bg-muted-foreground/40',
                className,
            )}
        />
    );
}

/** Online / Away / Offline for the signed-in agent. A native select: reachable by keyboard and touch, no popover to manage. */
export function PresenceSelect({
    id,
    status,
    onChange,
}: {
    id?: string;
    status: PresenceStatus | null;
    onChange: (status: PresenceStatus) => void;
}) {
    const { t } = useTrans();

    const hintId = `${id ?? 'presence'}-hint`;

    return (
        <div className="min-w-0">
            <div className="relative">
                <PresenceDot
                    status={status}
                    className="pointer-events-none absolute start-3 top-1/2 z-10 -translate-y-1/2"
                />
                <NativeSelect
                    id={id}
                    data-testid="presence-select"
                    aria-label={t('inbox.presence.label')}
                    aria-describedby={status === 'online' ? hintId : undefined}
                    value={status ?? ''}
                    disabled={status === null}
                    onChange={(event) =>
                        onChange(event.target.value as PresenceStatus)
                    }
                    className="h-9 ps-8"
                >
                    {status === null && <option value="">…</option>}
                    {STATUSES.map((value) => (
                        <option key={value} value={value}>
                            {t(`inbox.presence.${value}`)}
                        </option>
                    ))}
                </NativeSelect>
            </div>
            {status === 'online' && (
                <p
                    id={hintId}
                    data-testid="presence-hint"
                    className="mt-1 text-xs text-muted-foreground"
                >
                    {t('presence.hint.online')}
                </p>
            )}
        </div>
    );
}
