import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import type { WaListFilters } from '@/lib/realtime/whatsapp/use-wa-chat-list';
import type { WhatsAppSession } from '@/lib/whatsapp/types';
import { cn } from '@/lib/utils';

function Chip({
    pressed,
    onClick,
    testId,
    children,
}: {
    pressed: boolean;
    onClick: () => void;
    testId: string;
    children: string;
}) {
    return (
        <button
            type="button"
            data-testid={testId}
            aria-pressed={pressed}
            onClick={onClick}
            className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150 outline-none',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                pressed
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
        >
            {children}
        </button>
    );
}

/**
 * Search and filters of the chat list: the text (server side: numbers, names, message texts), open / archived, linked to the website or
 * not, only the unread, unread first, and one session. Every control is labelled; the chips are toggle buttons (`aria-pressed`).
 */
export function ChatFilters({
    filters,
    sessions,
    onChange,
}: {
    filters: WaListFilters;
    sessions: Pick<WhatsAppSession, 'ulid' | 'name'>[];
    onChange: (patch: Partial<WaListFilters>) => void;
}) {
    const { t } = useTrans();

    return (
        <div className="grid gap-2">
            <div className="relative">
                <Search
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                />
                <Input
                    type="search"
                    value={filters.q}
                    onChange={(event) => onChange({ q: event.target.value })}
                    placeholder={t('whatsapp.list.search')}
                    aria-label={t('whatsapp.list.search')}
                    data-testid="wa-search"
                    className="h-9 ps-9"
                />
            </div>

            <div
                role="group"
                aria-label={t('whatsapp.list.filter')}
                className="flex flex-wrap gap-1"
            >
                <Chip
                    testId="wa-filter-open"
                    pressed={filters.status === 'open'}
                    onClick={() =>
                        onChange({
                            status: filters.status === 'open' ? 'all' : 'open',
                        })
                    }
                >
                    {t('whatsapp.filter.open')}
                </Chip>
                <Chip
                    testId="wa-filter-archived"
                    pressed={filters.status === 'archived'}
                    onClick={() =>
                        onChange({
                            status:
                                filters.status === 'archived'
                                    ? 'open'
                                    : 'archived',
                        })
                    }
                >
                    {t('whatsapp.filter.archived')}
                </Chip>
                <Chip
                    testId="wa-filter-linked"
                    pressed={filters.linked === 'linked'}
                    onClick={() =>
                        onChange({
                            linked:
                                filters.linked === 'linked' ? 'all' : 'linked',
                        })
                    }
                >
                    {t('whatsapp.filter.linked')}
                </Chip>
                <Chip
                    testId="wa-filter-unlinked"
                    pressed={filters.linked === 'unlinked'}
                    onClick={() =>
                        onChange({
                            linked:
                                filters.linked === 'unlinked'
                                    ? 'all'
                                    : 'unlinked',
                        })
                    }
                >
                    {t('whatsapp.filter.unlinked')}
                </Chip>
                <Chip
                    testId="wa-filter-unread"
                    pressed={filters.unreadOnly}
                    onClick={() =>
                        onChange({ unreadOnly: !filters.unreadOnly })
                    }
                >
                    {t('whatsapp.filter.unread')}
                </Chip>
                <Chip
                    testId="wa-filter-unread-first"
                    pressed={filters.sort === 'unread'}
                    onClick={() =>
                        onChange({
                            sort:
                                filters.sort === 'unread' ? 'recent' : 'unread',
                        })
                    }
                >
                    {t('whatsapp.filter.unread_first')}
                </Chip>
            </div>

            {sessions.length > 1 && (
                <label className="grid gap-1 text-xs text-muted-foreground">
                    <span>{t('whatsapp.filter.session')}</span>
                    <select
                        value={filters.session}
                        onChange={(event) =>
                            onChange({ session: event.target.value })
                        }
                        data-testid="wa-filter-session"
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                        <option value="">
                            {t('whatsapp.filter.all_sessions')}
                        </option>
                        {sessions.map((session) => (
                            <option key={session.ulid} value={session.ulid}>
                                {session.name}
                            </option>
                        ))}
                    </select>
                </label>
            )}
        </div>
    );
}
