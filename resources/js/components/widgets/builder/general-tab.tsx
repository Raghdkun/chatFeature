import { CircleSlash, Clock, Radio } from 'lucide-react';
import { useId } from 'react';
import {
    settingAction,
    settingError,
} from '@/components/widgets/builder-state';
import { EnabledControl } from '@/components/widgets/builder/enabled-control';
import {
    LocaleSelect,
    TimeZoneSelect,
} from '@/components/widgets/builder/selects';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import {
    CopyButton,
    NumberField,
    SectionCard,
    SegmentedChoice,
    SwitchRow,
    TextField,
} from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/limits';
import { IDLE_TIMEOUT_DEFAULT } from '@/lib/widget-config';
import type { OfflineMode } from '@/types/widgets';

/** Shared by General and Hours: both edit the same `offline_mode` column. */
export function OfflineModeChoice({
    state,
    dispatch,
    name,
}: TabProps & { name: string }) {
    const { t } = useTrans();

    return (
        <SegmentedChoice<OfflineMode>
            legend={t('builder.general.offline_mode')}
            name={name}
            value={state.doc.settings.offline_mode}
            onChange={(value) => dispatch(settingAction('offline_mode', value))}
            options={[
                {
                    value: 'auto_hours',
                    label: t('builder.mode.auto_hours'),
                    icon: <Clock className="size-4" aria-hidden />,
                },
                {
                    value: 'always_online',
                    label: t('builder.mode.always_online'),
                    icon: <Radio className="size-4" aria-hidden />,
                },
                {
                    value: 'always_offline',
                    label: t('builder.mode.always_offline'),
                    icon: <CircleSlash className="size-4" aria-hidden />,
                },
            ]}
            hint={t(`builder.mode.${state.doc.settings.offline_mode}_hint`)}
            error={settingError(state.errors, 'offline_mode')}
            testId="builder-offline-mode"
        />
    );
}

export function GeneralTab({
    state,
    dispatch,
    busy,
    onSetEnabled,
}: TabProps & {
    /** A save / publish / switch is running: the live switch waits. */
    busy: boolean;
    onSetEnabled: (next: boolean) => Promise<string | null>;
}) {
    const { t } = useTrans();
    const uid = useId();
    const { settings, config } = state.doc;
    const err = (key: Parameters<typeof settingError>[1]) =>
        settingError(state.errors, key);

    return (
        <div className="grid gap-5" data-testid="builder-panel-general">
            <SectionCard
                live
                title={t('builder.general.identity_title')}
                description={t('builder.general.identity_description')}
            >
                <TextField
                    id={`${uid}-name`}
                    label={t('builder.general.name')}
                    value={settings.name}
                    onValueChange={(value) =>
                        dispatch(settingAction('name', value))
                    }
                    maxLength={LIMITS.nameLength}
                    error={err('name')}
                    autoComplete="off"
                />

                <div className="grid gap-1.5">
                    <p className="text-sm font-medium">
                        {t('builder.general.public_key')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <code
                            dir="ltr"
                            data-testid="builder-public-key"
                            className="rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs"
                        >
                            {state.meta.publicKey}
                        </code>
                        <CopyButton
                            value={state.meta.publicKey}
                            label={t('widgets.copy_key')}
                        />
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {t('builder.general.public_key_hint')}
                    </p>
                </div>

                <EnabledControl
                    enabled={settings.is_enabled}
                    disabled={busy}
                    onChange={onSetEnabled}
                />
            </SectionCard>

            <SectionCard
                live
                title={t('builder.general.language_title')}
                description={t('builder.general.language_description')}
            >
                <div className="grid gap-5 sm:grid-cols-2">
                    <LocaleSelect
                        id={`${uid}-locale`}
                        label={t('builder.general.default_locale')}
                        value={settings.locale}
                        extra={Object.keys(config.texts)}
                        onValueChange={(value) =>
                            dispatch(settingAction('locale', value))
                        }
                        error={err('locale')}
                    />
                    <TimeZoneSelect
                        id={`${uid}-timezone`}
                        label={t('builder.general.timezone')}
                        hint={t('builder.general.timezone_hint')}
                        value={settings.timezone}
                        onValueChange={(value) =>
                            dispatch(settingAction('timezone', value))
                        }
                        error={err('timezone')}
                    />
                </div>
            </SectionCard>

            <SectionCard
                live
                title={t('builder.general.timing_title')}
                description={t('builder.general.timing_description')}
            >
                <div className="grid gap-5 sm:grid-cols-2">
                    <NumberField
                        id={`${uid}-idle`}
                        label={t('builder.general.idle_timeout')}
                        value={settings.idle_timeout_minutes}
                        onValueChange={(value) =>
                            dispatch(
                                settingAction('idle_timeout_minutes', value),
                            )
                        }
                        min={LIMITS.idleTimeoutMinutes.min}
                        max={LIMITS.idleTimeoutMinutes.max}
                        suffix={t('builder.unit.minutes')}
                        hint={t('builder.general.idle_hint', {
                            minutes: settings.idle_timeout_minutes,
                            default: IDLE_TIMEOUT_DEFAULT,
                        })}
                        error={err('idle_timeout_minutes')}
                    />
                    <NumberField
                        id={`${uid}-queue`}
                        label={t('builder.general.queue_timeout')}
                        value={settings.queue_timeout_seconds}
                        onValueChange={(value) =>
                            dispatch(
                                settingAction('queue_timeout_seconds', value),
                            )
                        }
                        min={LIMITS.queueTimeoutSeconds.min}
                        max={LIMITS.queueTimeoutSeconds.max}
                        suffix={t('builder.unit.seconds')}
                        hint={t('builder.general.queue_hint')}
                        error={err('queue_timeout_seconds')}
                    />
                </div>
            </SectionCard>

            <SectionCard
                live
                title={t('builder.general.availability_title')}
                description={t('builder.general.availability_description')}
            >
                <OfflineModeChoice
                    state={state}
                    dispatch={dispatch}
                    name={`${uid}-offline-mode`}
                />
                <SwitchRow
                    id={`${uid}-non-browser`}
                    label={t('builder.general.non_browser')}
                    description={t('builder.general.non_browser_hint')}
                    checked={settings.allow_non_browser_clients}
                    onCheckedChange={(value) =>
                        dispatch(
                            settingAction('allow_non_browser_clients', value),
                        )
                    }
                    testId="builder-non-browser"
                />
            </SectionCard>
        </div>
    );
}
