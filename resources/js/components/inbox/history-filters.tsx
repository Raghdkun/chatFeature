import { Download, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
    exportUrl,
    hasActiveFilters,
    NO_FILTERS,
} from '@/components/inbox/history-model';
import { NativeSelect } from '@/components/setup/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTrans } from '@/hooks/use-trans';
import type { HistoryFilterOptions, HistoryFilters } from '@/types/chat-staff';

const STATUSES = ['queued', 'active', 'ended', 'closed', 'missed'];
const TYPES = ['live', 'offline'];
/** The search box waits for a pause in typing before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 350;

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="grid min-w-0 gap-1">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            {children}
        </div>
    );
}

/** Filters, search and export of the history table. Every change is applied through `onChange` (the page turns it into a partial reload). */
export function HistoryFiltersBar({
    filters,
    options,
    onChange,
}: {
    filters: HistoryFilters;
    options: HistoryFilterOptions;
    onChange: (filters: HistoryFilters) => void;
}) {
    const { t } = useTrans();
    const [query, setQuery] = useState(filters.q);
    // The last search text THIS box sent: the server's echo of it must not overwrite what has been typed since.
    const sent = useRef(filters.q);

    // Follow the server only for changes that did not come from here (reset, back button).
    useEffect(() => {
        if (filters.q !== sent.current) {
            sent.current = filters.q;
            // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors an externally controlled value
            setQuery(filters.q);
        }
    }, [filters.q]);

    useEffect(() => {
        if (query === filters.q) {
            return;
        }

        const timer = setTimeout(() => {
            sent.current = query;
            onChange({ ...filters, q: query });
        }, SEARCH_DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [query, filters, onChange]);

    const set = (key: keyof HistoryFilters) => (value: string) =>
        onChange({ ...filters, [key]: value });

    return (
        <form
            role="search"
            aria-label={t('history.filters.label')}
            data-testid="history-filters"
            onSubmit={(event) => {
                event.preventDefault();
                sent.current = query;
                onChange({ ...filters, q: query });
            }}
            className="grid gap-3 border-b p-3 sm:p-4"
        >
            <div className="relative">
                <Search
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                />
                <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('history.filters.search')}
                    aria-label={t('history.filters.search')}
                    data-testid="history-search"
                    className="ps-9"
                />
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                <Field label={t('history.filters.status')}>
                    <NativeSelect
                        aria-label={t('history.filters.status')}
                        data-testid="history-filter-status"
                        value={filters.status}
                        onChange={(event) => set('status')(event.target.value)}
                    >
                        <option value="">{t('history.filters.any')}</option>
                        {STATUSES.map((status) => (
                            <option key={status} value={status}>
                                {t(`inbox.status.${status}`)}
                            </option>
                        ))}
                    </NativeSelect>
                </Field>
                <Field label={t('history.filters.type')}>
                    <NativeSelect
                        aria-label={t('history.filters.type')}
                        data-testid="history-filter-type"
                        value={filters.type}
                        onChange={(event) => set('type')(event.target.value)}
                    >
                        <option value="">{t('history.filters.any')}</option>
                        {TYPES.map((type) => (
                            <option key={type} value={type}>
                                {t(`inbox.type.${type}`)}
                            </option>
                        ))}
                    </NativeSelect>
                </Field>
                <Field label={t('history.filters.category')}>
                    <NativeSelect
                        aria-label={t('history.filters.category')}
                        data-testid="history-filter-category"
                        value={filters.category}
                        onChange={(event) =>
                            set('category')(event.target.value)
                        }
                    >
                        <option value="">{t('history.filters.any')}</option>
                        {options.categories.map((category) => (
                            <option key={category.ulid} value={category.ulid}>
                                {category.name}
                            </option>
                        ))}
                    </NativeSelect>
                </Field>
                <Field label={t('history.filters.widget')}>
                    <NativeSelect
                        aria-label={t('history.filters.widget')}
                        data-testid="history-filter-widget"
                        value={filters.widget}
                        onChange={(event) => set('widget')(event.target.value)}
                    >
                        <option value="">{t('history.filters.any')}</option>
                        {options.widgets.map((widget) => (
                            <option key={widget.ulid} value={widget.ulid}>
                                {widget.name}
                            </option>
                        ))}
                    </NativeSelect>
                </Field>
                <Field label={t('history.filters.agent')}>
                    <NativeSelect
                        aria-label={t('history.filters.agent')}
                        data-testid="history-filter-agent"
                        value={filters.agent}
                        onChange={(event) => set('agent')(event.target.value)}
                    >
                        <option value="">{t('history.filters.any')}</option>
                        {options.agents.map((agent) => (
                            <option key={agent.id} value={String(agent.id)}>
                                {agent.name}
                            </option>
                        ))}
                    </NativeSelect>
                </Field>
                <Field label={t('history.filters.from')}>
                    <Input
                        type="date"
                        value={filters.from}
                        max={filters.to || undefined}
                        aria-label={t('history.filters.from')}
                        data-testid="history-filter-from"
                        onChange={(event) => set('from')(event.target.value)}
                    />
                </Field>
                <Field label={t('history.filters.to')}>
                    <Input
                        type="date"
                        value={filters.to}
                        min={filters.from || undefined}
                        aria-label={t('history.filters.to')}
                        data-testid="history-filter-to"
                        onChange={(event) => set('to')(event.target.value)}
                    />
                </Field>
                <div className="col-span-2 flex items-end justify-end gap-2 md:col-span-4 xl:col-span-1">
                    <Button
                        type="button"
                        variant="ghost"
                        data-testid="history-reset"
                        disabled={!hasActiveFilters(filters)}
                        onClick={() => onChange(NO_FILTERS)}
                    >
                        <X aria-hidden />
                        {t('history.filters.reset')}
                    </Button>
                    <Button asChild variant="outline">
                        <a
                            href={exportUrl(filters)}
                            download
                            data-testid="history-export"
                        >
                            <Download aria-hidden />
                            {t('history.export')}
                        </a>
                    </Button>
                </div>
            </div>
        </form>
    );
}
