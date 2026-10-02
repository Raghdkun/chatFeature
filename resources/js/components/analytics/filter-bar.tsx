import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NativeSelect } from '@/components/setup/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTrans } from '@/hooks/use-trans';
import { exportUrl } from '@/lib/analytics/client';
import {
    matchPreset,
    PRESETS,
    presetRange,
    rangeProblem,
    type Preset,
} from '@/lib/analytics/ranges';
import type { FilterOption, Filters } from '@/lib/analytics/types';
import { cn } from '@/lib/utils';

type Options = {
    widgets: FilterOption[];
    categories: FilterOption[];
    agents: FilterOption[];
};

/**
 * The one row above the charts that scopes everything below it: the period (presets first, then a custom range), the comparison switch and,
 * for administrators, ONE filter by widget, topic or agent (the rollup holds one row per widget, topic or agent, not their crossings, so
 * choosing one clears the others), and the CSV export. Every change goes through `onChange`; the page re-queries all reports with it.
 */
export function FilterBar({
    filters,
    today,
    options,
    admin,
    onChange,
}: {
    filters: Filters;
    today: string;
    options: Options;
    admin: boolean;
    onChange: (filters: Filters) => void;
}) {
    const { t } = useTrans();
    const preset = matchPreset(filters.from, filters.to, today);
    const [custom, setCustom] = useState(preset === null);
    const [draft, setDraft] = useState({ from: filters.from, to: filters.to });
    const problem = rangeProblem(draft.from, draft.to);

    // Follow changes that did not come from the inputs (a preset, the browser's back button).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors an externally controlled value
        setDraft({ from: filters.from, to: filters.to });
    }, [filters.from, filters.to]);

    const apply = (next: { from: string; to: string }) => {
        setDraft(next);

        if (rangeProblem(next.from, next.to) === null) {
            onChange({
                ...filters,
                ...next,
                to: next.to > today ? today : next.to,
            });
        }
    };

    const choose = (name: Preset) => {
        setCustom(false);
        onChange({ ...filters, ...presetRange(name, today) });
    };

    const pick =
        (key: 'widget' | 'category' | 'agent') =>
        (event: React.ChangeEvent<HTMLSelectElement>) => {
            const value = event.target.value;

            onChange({
                ...filters,
                widget: key === 'widget' && value ? value : null,
                category: key === 'category' && value ? value : null,
                agent: key === 'agent' && value ? Number(value) : null,
            });
        };

    const filtered =
        filters.widget !== null ||
        filters.category !== null ||
        filters.agent !== null;

    return (
        <form
            role="search"
            aria-label={t('analytics.filters.label')}
            data-testid="analytics-filters"
            onSubmit={(event) => event.preventDefault()}
            className="grid gap-3 rounded-xl border bg-card p-3 sm:p-4"
        >
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                <fieldset className="grid min-w-0 gap-1">
                    <legend className="mb-1 text-xs text-muted-foreground">
                        {t('analytics.filters.range')}
                    </legend>
                    <div
                        role="group"
                        className="flex flex-wrap gap-1.5"
                        data-testid="analytics-presets"
                    >
                        {PRESETS.map((name) => (
                            <Button
                                key={name}
                                type="button"
                                size="sm"
                                variant={
                                    !custom && preset === name
                                        ? 'default'
                                        : 'outline'
                                }
                                aria-pressed={!custom && preset === name}
                                data-testid={`analytics-preset-${name}`}
                                onClick={() => choose(name)}
                            >
                                {t(`analytics.filters.preset.${name}`)}
                            </Button>
                        ))}
                        <Button
                            type="button"
                            size="sm"
                            variant={custom ? 'default' : 'outline'}
                            aria-pressed={custom}
                            aria-expanded={custom}
                            data-testid="analytics-preset-custom"
                            onClick={() => setCustom((value) => !value)}
                        >
                            {t('analytics.filters.custom')}
                        </Button>
                    </div>
                </fieldset>

                {custom && (
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="grid gap-1">
                            <Label
                                htmlFor="analytics-from"
                                className="text-xs text-muted-foreground"
                            >
                                {t('analytics.filters.from')}
                            </Label>
                            <Input
                                id="analytics-from"
                                type="date"
                                value={draft.from}
                                max={today}
                                data-testid="analytics-from"
                                aria-invalid={problem !== null}
                                aria-describedby={
                                    problem
                                        ? 'analytics-range-problem'
                                        : undefined
                                }
                                onChange={(event) =>
                                    apply({
                                        ...draft,
                                        from: event.target.value,
                                    })
                                }
                                className="w-40"
                            />
                        </div>
                        <div className="grid gap-1">
                            <Label
                                htmlFor="analytics-to"
                                className="text-xs text-muted-foreground"
                            >
                                {t('analytics.filters.to')}
                            </Label>
                            <Input
                                id="analytics-to"
                                type="date"
                                value={draft.to}
                                max={today}
                                data-testid="analytics-to"
                                aria-invalid={problem !== null}
                                aria-describedby={
                                    problem
                                        ? 'analytics-range-problem'
                                        : undefined
                                }
                                onChange={(event) =>
                                    apply({ ...draft, to: event.target.value })
                                }
                                className="w-40"
                            />
                        </div>
                    </div>
                )}

                <label className="flex items-center gap-2 pb-1.5 text-sm">
                    <input
                        type="checkbox"
                        checked={filters.compare}
                        data-testid="analytics-compare"
                        onChange={(event) =>
                            onChange({
                                ...filters,
                                compare: event.target.checked,
                            })
                        }
                        className="size-4 accent-primary"
                    />
                    {t('analytics.filters.compare')}
                </label>

                {admin && (
                    <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="ms-auto"
                    >
                        <a
                            data-testid="analytics-export"
                            href={exportUrl({
                                from: filters.from,
                                to: filters.to,
                                widget: filters.widget,
                                category: filters.category,
                                agent: filters.agent,
                            })}
                            download
                        >
                            <Download aria-hidden />
                            {t('analytics.export')}
                        </a>
                    </Button>
                )}
            </div>

            {problem && (
                <p
                    id="analytics-range-problem"
                    role="alert"
                    data-testid="analytics-range-problem"
                    className="text-sm text-destructive"
                >
                    {t(`analytics.filters.problem.${problem}`)}
                </p>
            )}

            {admin && (
                <div className="grid gap-1">
                    <div
                        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                        role="group"
                        aria-label={t('analytics.filters.scope')}
                    >
                        {(
                            [
                                [
                                    'widget',
                                    options.widgets,
                                    filters.widget ?? '',
                                ],
                                [
                                    'category',
                                    options.categories,
                                    filters.category ?? '',
                                ],
                                [
                                    'agent',
                                    options.agents,
                                    filters.agent === null
                                        ? ''
                                        : String(filters.agent),
                                ],
                            ] as const
                        ).map(([key, list, value]) => (
                            <div key={key} className="grid min-w-0 gap-1">
                                <Label
                                    htmlFor={`analytics-filter-${key}`}
                                    className="text-xs text-muted-foreground"
                                >
                                    {t(`analytics.filters.${key}`)}
                                </Label>
                                <NativeSelect
                                    id={`analytics-filter-${key}`}
                                    data-testid={`analytics-filter-${key}`}
                                    value={value}
                                    onChange={pick(key)}
                                    className={cn(
                                        value !== '' && 'border-primary',
                                    )}
                                >
                                    <option value="">
                                        {t('analytics.filters.all')}
                                    </option>
                                    {list.map((option) => (
                                        <option
                                            key={option.key}
                                            value={option.key}
                                        >
                                            {option.deleted
                                                ? t(
                                                      'analytics.filters.deleted',
                                                      {
                                                          name: option.label,
                                                      },
                                                  )
                                                : option.label}
                                        </option>
                                    ))}
                                </NativeSelect>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {filtered
                            ? t('analytics.filters.one_at_a_time')
                            : t('analytics.filters.scope_hint')}
                    </p>
                </div>
            )}
        </form>
    );
}
