import { Download, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import type { WaListFilters } from '@/lib/realtime/whatsapp/use-wa-chat-list';
import type {
    WaCategoryRef,
    WaWidgetRef,
    WhatsAppSession,
} from '@/lib/whatsapp/types';
import { exportUrl } from '@/lib/whatsapp-api/client';
import { WA_LIMITS } from '@/lib/whatsapp-api/types';
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

function FilterSelect({
    label,
    all,
    testId,
    value,
    options,
    onChange,
}: {
    label: string;
    all: string;
    testId: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
}) {
    return (
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            <span>{label}</span>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                data-testid={testId}
                className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
                <option value="">{all}</option>
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

/**
 * Search and filters of the chat list: the text (server side: numbers, names, message texts), open / archived, linked to the website or
 * not, only the unread, unread first, and one session. Every control is labelled; the chips are toggle buttons (`aria-pressed`).
 */
export function ChatFilters({
    filters,
    sessions,
    widgets,
    categories,
    onChange,
}: {
    filters: WaListFilters;
    sessions: Pick<WhatsAppSession, 'ulid' | 'name'>[];
    widgets: WaWidgetRef[];
    categories: WaCategoryRef[];
    onChange: (patch: Partial<WaListFilters>) => void;
}) {
    const { t } = useTrans();

    return (
        <div className="grid min-w-0 gap-2">
            <div className="relative">
                <Search
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                />
                <Input
                    type="search"
                    value={filters.q}
                    maxLength={WA_LIMITS.searchMax}
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
                <FilterSelect
                    label={t('whatsapp.filter.session')}
                    all={t('whatsapp.filter.all_sessions')}
                    testId="wa-filter-session"
                    value={filters.session}
                    options={sessions.map((s) => ({
                        value: s.ulid,
                        label: s.name,
                    }))}
                    onChange={(session) => onChange({ session })}
                />
            )}
            {widgets.length > 1 && (
                <FilterSelect
                    label={t('whatsapp.filter.widget')}
                    all={t('whatsapp.filter.all_widgets')}
                    testId="wa-filter-widget"
                    value={filters.widget}
                    options={widgets.map((w) => ({
                        value: w.ulid,
                        label: w.name,
                    }))}
                    onChange={(widget) => onChange({ widget })}
                />
            )}
            {categories.length > 1 && (
                <FilterSelect
                    label={t('whatsapp.filter.category')}
                    all={t('whatsapp.filter.all_categories')}
                    testId="wa-filter-category"
                    value={filters.category}
                    options={categories.map((c) => ({
                        value: c.slug,
                        label: c.label,
                    }))}
                    onChange={(category) => onChange({ category })}
                />
            )}

            <details className="group text-xs" data-testid="wa-export">
                <summary className="flex min-h-6 w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                    <Download className="size-3.5" aria-hidden />
                    {t('whatsapp.export.button')}
                </summary>
                <div className="mt-1.5 grid gap-1 ps-5">
                    {(
                        [
                            ['messages', 'csv'],
                            ['messages', 'json'],
                            ['chats', 'csv'],
                        ] as const
                    ).map(([resource, format]) => (
                        <a
                            key={`${resource}-${format}`}
                            href={exportUrl(filters, { format, resource })}
                            data-testid={`wa-export-${resource}-${format}`}
                            className="inline-flex min-h-6 w-fit items-center rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                            {t(`whatsapp.export.${resource}_${format}`)}
                        </a>
                    ))}
                    <p className="text-muted-foreground">
                        {t('whatsapp.export.hint')}
                    </p>
                </div>
            </details>
        </div>
    );
}
