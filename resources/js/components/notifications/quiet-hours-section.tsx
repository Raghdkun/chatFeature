import { useState } from 'react';
import { toast } from 'sonner';
import { describedBy, Field } from '@/components/setup/field';
import { Input } from '@/components/ui/input';
import { SectionCard, SwitchRow } from '@/components/widgets/form-bits';
import { TimeZoneSelect } from '@/components/widgets/builder/selects';
import { useTrans } from '@/hooks/use-trans';
import type { NotificationsController } from '@/lib/notifications/controller';
import type {
    NotificationSettings,
    QuietHoursSetting,
} from '@/lib/notifications/types';

/** Whether the window runs past midnight (start after end), for the hint under the times. */
export function isOvernight(
    hours: Pick<QuietHoursSetting, 'start' | 'end'>,
): boolean {
    return hours.start > hours.end;
}

/**
 * Quiet hours: no push notifications between two wall-clock times in a time zone (overnight windows work). The change is saved as
 * soon as it is made; equal start and end times are refused here (the server refuses them too).
 */
export function QuietHoursSection({
    controller,
    settings,
}: {
    controller: NotificationsController;
    settings: NotificationSettings;
}) {
    const { t } = useTrans();
    const hours = settings.quietHours;
    const [problem, setProblem] = useState<string | null>(null);
    const endHint =
        hours.enabled && isOvernight(hours)
            ? t('notifications.quiet.overnight')
            : undefined;

    const save = async (patch: Partial<QuietHoursSetting>): Promise<void> => {
        const next = { ...hours, ...patch };

        if (next.enabled && next.start === next.end) {
            setProblem(t('notifications.quiet.same_time'));

            return;
        }

        setProblem(null);

        if (!(await controller.updateSettings({ quietHours: patch }))) {
            toast.error(t('notifications.settings.save_failed'));
        }
    };

    return (
        <SectionCard
            title={t('notifications.quiet.title')}
            description={t('notifications.quiet.description')}
            testId="notifications-quiet"
        >
            <SwitchRow
                id="notifications-quiet-enabled"
                label={t('notifications.quiet.enabled')}
                checked={hours.enabled}
                onCheckedChange={(enabled) => void save({ enabled })}
                testId="notifications-quiet-enabled"
            />

            <div className="grid gap-4 sm:grid-cols-2">
                <Field
                    id="notifications-quiet-start"
                    label={t('notifications.quiet.start')}
                >
                    <Input
                        id="notifications-quiet-start"
                        type="time"
                        value={hours.start}
                        disabled={!hours.enabled}
                        data-testid="notifications-quiet-start"
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={
                            problem
                                ? 'notifications-quiet-end-error'
                                : undefined
                        }
                        onChange={(event) =>
                            event.target.value !== '' &&
                            void save({ start: event.target.value })
                        }
                    />
                </Field>
                <Field
                    id="notifications-quiet-end"
                    label={t('notifications.quiet.end')}
                    hint={endHint}
                    error={problem ?? undefined}
                >
                    <Input
                        id="notifications-quiet-end"
                        type="time"
                        value={hours.end}
                        disabled={!hours.enabled}
                        data-testid="notifications-quiet-end"
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={describedBy(
                            'notifications-quiet-end',
                            {
                                hint: endHint,
                                error: problem ?? undefined,
                            },
                        )}
                        onChange={(event) =>
                            event.target.value !== '' &&
                            void save({ end: event.target.value })
                        }
                    />
                </Field>
            </div>

            <TimeZoneSelect
                id="notifications-quiet-timezone"
                label={t('notifications.quiet.timezone')}
                value={hours.timezone}
                onValueChange={(timezone) => void save({ timezone })}
            />
        </SectionCard>
    );
}
