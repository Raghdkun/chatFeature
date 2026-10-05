import { CalendarPlus, Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import {
    canAddRange,
    errorsUnder,
    settingAction,
    settingError,
} from '@/components/widgets/builder-state';
import { OfflineModeChoice } from '@/components/widgets/builder/general-tab';
import { OpenNow } from '@/components/widgets/builder/open-now';
import { TimeZoneSelect } from '@/components/widgets/builder/selects';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import {
    ErrorLines,
    Notice,
    SectionCard,
} from '@/components/widgets/form-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/limits';
import { WEEK_ORDER, weekdayName } from '@/lib/widget-config';
import { cn } from '@/lib/utils';
import type { HoursRange } from '@/types/widgets';

const WORKING_WEEK: HoursRange[] = [1, 2, 3, 4, 5].map((day) => ({
    day,
    start: '09:00',
    end: '17:00',
}));

export function HoursTab({ state, dispatch }: TabProps) {
    const { t, locale } = useTrans();
    const uid = useId();
    const { hours } = state.doc.config;
    const { settings } = state.doc;
    const scheduleActive = settings.offline_mode === 'auto_hours';
    const indexed = hours.schedule.map((range, index) => ({ ...range, index }));
    // Server errors arrive as `config.hours.schedule.N.start|end` (overlap, order) and
    // `config.hours.holidays.N.date` (duplicate): read everything under the item, not one exact path.
    const scheduleErrors = state.errors['config.hours.schedule'] ?? [];
    const holidayErrors = state.errors['config.hours.holidays'] ?? [];

    return (
        <div className="grid gap-5" data-testid="builder-panel-hours">
            <OpenNow
                mode={settings.offline_mode}
                timeZone={settings.timezone}
                schedule={hours.schedule}
                holidays={hours.holidays}
                testId="builder-hours-now"
            />
            <SectionCard
                live
                title={t('builder.hours.mode_title')}
                description={t('builder.hours.mode_description')}
            >
                <OfflineModeChoice
                    state={state}
                    dispatch={dispatch}
                    name={`${uid}-mode`}
                />
                <div className="max-w-sm">
                    <TimeZoneSelect
                        id={`${uid}-timezone`}
                        label={t('builder.general.timezone')}
                        hint={t('builder.hours.timezone_hint')}
                        value={settings.timezone}
                        onValueChange={(value) =>
                            dispatch(settingAction('timezone', value))
                        }
                        error={settingError(state.errors, 'timezone')}
                    />
                </div>
            </SectionCard>

            <SectionCard
                title={t('builder.hours.schedule_title')}
                description={t('builder.hours.schedule_description')}
                actions={
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid="builder-hours-preset"
                            onClick={() =>
                                dispatch({
                                    type: 'hours/set-schedule',
                                    schedule: WORKING_WEEK,
                                })
                            }
                        >
                            {t('builder.hours.preset_weekdays')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={hours.schedule.length === 0}
                            data-testid="builder-hours-clear"
                            onClick={() =>
                                dispatch({
                                    type: 'hours/set-schedule',
                                    schedule: [],
                                })
                            }
                        >
                            {t('builder.hours.clear')}
                        </Button>
                    </div>
                }
            >
                {!scheduleActive && (
                    <Notice data-testid="builder-hours-inactive">
                        {t('builder.hours.inactive_notice', {
                            mode: t(`builder.mode.${settings.offline_mode}`),
                        })}
                    </Notice>
                )}

                <ErrorLines
                    messages={scheduleErrors}
                    data-testid="builder-hours-schedule-errors"
                />

                <ul
                    className={cn(
                        'divide-y rounded-lg border',
                        // Inactive: a tint, not opacity (dimmed text fell under the contrast minimum); the notice above says why.
                        !scheduleActive && 'bg-muted/40',
                    )}
                >
                    {WEEK_ORDER.map((day) => {
                        const ranges = indexed.filter(
                            (range) => range.day === day,
                        );

                        return (
                            <li
                                key={day}
                                data-testid={`builder-hours-day-${day}`}
                                className="grid gap-2 p-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-start"
                            >
                                <p className="pt-1.5 text-sm font-medium">
                                    {weekdayName(day, locale)}
                                </p>
                                <div className="grid gap-2">
                                    {ranges.length === 0 ? (
                                        <p className="pt-1.5 text-sm text-muted-foreground">
                                            {t('builder.hours.closed')}
                                        </p>
                                    ) : (
                                        ranges.map((range) => {
                                            const messages = errorsUnder(
                                                state.errors,
                                                `config.hours.schedule.${range.index}`,
                                            );
                                            const error = messages.length > 0;

                                            return (
                                                <div
                                                    key={range.index}
                                                    className="grid gap-1"
                                                >
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <Input
                                                            type="time"
                                                            value={range.start}
                                                            aria-label={t(
                                                                'builder.hours.opens',
                                                                {
                                                                    day: weekdayName(
                                                                        day,
                                                                        locale,
                                                                    ),
                                                                },
                                                            )}
                                                            aria-invalid={
                                                                error
                                                                    ? true
                                                                    : undefined
                                                            }
                                                            onChange={(event) =>
                                                                dispatch({
                                                                    type: 'hours/update-range',
                                                                    index: range.index,
                                                                    patch: {
                                                                        start: event
                                                                            .target
                                                                            .value,
                                                                    },
                                                                })
                                                            }
                                                            data-testid={`builder-hours-start-${range.index}`}
                                                            className="w-32"
                                                        />
                                                        <span
                                                            aria-hidden
                                                            className="text-muted-foreground"
                                                        >
                                                            –
                                                        </span>
                                                        <Input
                                                            type="time"
                                                            value={range.end}
                                                            aria-label={t(
                                                                'builder.hours.closes',
                                                                {
                                                                    day: weekdayName(
                                                                        day,
                                                                        locale,
                                                                    ),
                                                                },
                                                            )}
                                                            aria-invalid={
                                                                error
                                                                    ? true
                                                                    : undefined
                                                            }
                                                            onChange={(event) =>
                                                                dispatch({
                                                                    type: 'hours/update-range',
                                                                    index: range.index,
                                                                    patch: {
                                                                        end: event
                                                                            .target
                                                                            .value,
                                                                    },
                                                                })
                                                            }
                                                            data-testid={`builder-hours-end-${range.index}`}
                                                            className="w-32"
                                                        />
                                                        <Button
                                                            type="button"
                                                            size="icon"
                                                            variant="ghost"
                                                            className="size-8 text-destructive-foreground hover:text-destructive-foreground"
                                                            aria-label={t(
                                                                'builder.hours.remove_range',
                                                                {
                                                                    day: weekdayName(
                                                                        day,
                                                                        locale,
                                                                    ),
                                                                },
                                                            )}
                                                            data-testid={`builder-hours-remove-${range.index}`}
                                                            onClick={() =>
                                                                dispatch({
                                                                    type: 'hours/remove-range',
                                                                    index: range.index,
                                                                })
                                                            }
                                                        >
                                                            <Trash2
                                                                aria-hidden
                                                            />
                                                        </Button>
                                                    </div>
                                                    <ErrorLines
                                                        messages={messages}
                                                        data-testid={`builder-hours-range-${range.index}-errors`}
                                                    />
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                                <div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        data-testid={`builder-hours-add-${day}`}
                                        disabled={
                                            !canAddRange(hours.schedule, day)
                                        }
                                        onClick={() =>
                                            dispatch({
                                                type: 'hours/add-range',
                                                day,
                                            })
                                        }
                                    >
                                        <Plus aria-hidden />
                                        {t('builder.hours.add_range')}
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </SectionCard>

            <SectionCard
                title={t('builder.hours.holidays_title')}
                description={t('builder.hours.holidays_description')}
                actions={
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="builder-holiday-add"
                        onClick={() => dispatch({ type: 'hours/add-holiday' })}
                    >
                        <CalendarPlus aria-hidden />
                        {t('builder.hours.add_holiday')}
                    </Button>
                }
            >
                <ErrorLines
                    messages={holidayErrors}
                    data-testid="builder-hours-holiday-errors"
                />

                {hours.holidays.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t('builder.hours.no_holidays')}
                    </p>
                ) : (
                    <ul className="grid gap-3">
                        {hours.holidays.map((holiday, index) => {
                            const messages = errorsUnder(
                                state.errors,
                                `config.hours.holidays.${index}`,
                            );
                            const error = messages.length > 0;

                            return (
                                <li
                                    key={index}
                                    data-testid={`builder-holiday-${index}`}
                                    className="grid gap-1"
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Input
                                            type="date"
                                            value={holiday.date}
                                            aria-label={t(
                                                'builder.hours.holiday_date',
                                                { n: index + 1 },
                                            )}
                                            aria-invalid={
                                                error ? true : undefined
                                            }
                                            onChange={(event) =>
                                                dispatch({
                                                    type: 'hours/update-holiday',
                                                    index,
                                                    patch: {
                                                        date: event.target
                                                            .value,
                                                    },
                                                })
                                            }
                                            data-testid={`builder-holiday-date-${index}`}
                                            className="w-44"
                                        />
                                        <Input
                                            value={holiday.label ?? ''}
                                            aria-label={t(
                                                'builder.hours.holiday_label',
                                                { n: index + 1 },
                                            )}
                                            placeholder={t(
                                                'builder.hours.holiday_placeholder',
                                            )}
                                            maxLength={
                                                LIMITS.holidayLabelLength
                                            }
                                            dir="auto"
                                            onChange={(event) =>
                                                dispatch({
                                                    type: 'hours/update-holiday',
                                                    index,
                                                    patch: {
                                                        label: event.target
                                                            .value,
                                                    },
                                                })
                                            }
                                            data-testid={`builder-holiday-label-${index}`}
                                            className="min-w-40 flex-1"
                                        />
                                        <Button
                                            type="button"
                                            size="icon"
                                            variant="ghost"
                                            className="size-8 text-destructive-foreground hover:text-destructive-foreground"
                                            aria-label={t(
                                                'builder.hours.remove_holiday',
                                                {
                                                    n: index + 1,
                                                },
                                            )}
                                            data-testid={`builder-holiday-remove-${index}`}
                                            onClick={() =>
                                                dispatch({
                                                    type: 'hours/remove-holiday',
                                                    index,
                                                })
                                            }
                                        >
                                            <Trash2 aria-hidden />
                                        </Button>
                                    </div>
                                    <ErrorLines
                                        messages={messages}
                                        data-testid={`builder-holiday-${index}-errors`}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                )}
            </SectionCard>
        </div>
    );
}
