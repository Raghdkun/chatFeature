import { Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { hoursStatus } from '@/lib/opening-hours';
import { weekdayName } from '@/lib/widget-config';
import type { Holiday, HoursRange, OfflineMode } from '@/types/widgets';

/**
 * What the hours mean RIGHT NOW: the trap of a new widget is that it follows business hours (Monday to Friday, 09:00-17:00 UTC), so a
 * first test at any other time quietly shows the offline form. `onlyWhenClosed` keeps it out of the way where it is only worth saying
 * when visitors would NOT get a chat (the Embed tab); the Hours tab always shows it.
 */
export function OpenNow({
    mode,
    timeZone,
    schedule,
    holidays,
    onlyWhenClosed = false,
    testId,
}: {
    mode: OfflineMode;
    timeZone: string;
    schedule: readonly HoursRange[];
    holidays: readonly Holiday[];
    onlyWhenClosed?: boolean;
    testId: string;
}) {
    const { t, locale } = useTrans();
    const status = hoursStatus(mode, timeZone, schedule, holidays);

    if (
        onlyWhenClosed &&
        (status.state === 'open' || status.state === 'always_online')
    ) {
        return null;
    }

    if (status.state === 'always_online') {
        return (
            <Notice data-testid={testId} data-state={status.state}>
                {t('builder.hours.now.always_online')}
            </Notice>
        );
    }

    if (status.state === 'always_offline') {
        return (
            <Notice
                tone="warning"
                data-testid={testId}
                data-state={status.state}
            >
                {t('builder.hours.now.always_offline')}
            </Notice>
        );
    }

    if (status.state === 'open') {
        return (
            <Notice
                tone="success"
                data-testid={testId}
                data-state={status.state}
            >
                {t('builder.hours.now.open', { zone: timeZone })}
            </Notice>
        );
    }

    const next = status.next;

    return (
        <Notice tone="warning" data-testid={testId} data-state={status.state}>
            {next === null
                ? t('builder.hours.now.closed_never')
                : t('builder.hours.now.closed_next', {
                      when:
                          next.daysAhead === 0
                              ? t('builder.hours.now.today', {
                                    time: next.start,
                                })
                              : `${weekdayName(next.day, locale)} ${next.start}`,
                      zone: timeZone,
                  })}
        </Notice>
    );
}
