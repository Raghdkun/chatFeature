import { Form } from '@inertiajs/react';
import { useState } from 'react';
import { describedBy, Field } from '@/components/setup/field';
import { NativeSelect } from '@/components/setup/native-select';
import { BackButton, SubmitButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import { Input } from '@/components/ui/input';
import { i18n, useTrans } from '@/hooks/use-trans';
import { localeLabel } from '@/lib/i18n';
import { LIMITS } from '@/lib/limits';
import {
    displayIdleTimeout,
    IDLE_TIMEOUT,
    parseIdleTimeout,
} from '@/lib/setup-flow';
import { setupRoutes } from '@/lib/setup-routes';
import {
    canonicalTimeZone,
    formatTimeZone,
    getTimeZones,
    groupTimeZones,
} from '@/lib/timezones';
import type { SetupState } from '@/types/setup';

export function StepBasics({
    setup,
    onBack,
}: {
    setup: SetupState;
    onBack: () => void;
}) {
    const { t } = useTrans();
    const { defaults } = setup;
    const [idleTimeout, setIdleTimeout] = useState(
        String(defaults.idle_timeout_minutes),
    );
    const idleInvalid =
        idleTimeout.trim() !== '' && parseIdleTimeout(idleTimeout) === null;

    const locales = [
        ...new Set([...i18n.availableLocales(), defaults.locale]),
    ].sort();
    const timeZoneGroups = groupTimeZones(getTimeZones(defaults.timezone));

    return (
        <Form {...setupRoutes.basics.form()} className="flex flex-1 flex-col">
            {({ processing, errors }) => (
                <StepFrame
                    step="basics"
                    title={t('setup.basics.title')}
                    description={t('setup.basics.description')}
                    footer={
                        <>
                            <BackButton onClick={onBack} />
                            <SubmitButton
                                label={t('setup.basics.submit')}
                                processing={processing}
                                testId="setup-basics-submit"
                            />
                        </>
                    }
                >
                    <div className="grid gap-5">
                        <Field
                            id="setup-app-name"
                            label={t('setup.basics.app_name')}
                            hint={t('setup.basics.app_name_hint')}
                            error={errors.app_name}
                        >
                            <Input
                                id="setup-app-name"
                                name="app_name"
                                required
                                autoFocus
                                maxLength={LIMITS.appNameLength}
                                defaultValue={defaults.app_name}
                                aria-invalid={
                                    errors.app_name ? true : undefined
                                }
                                aria-describedby={describedBy(
                                    'setup-app-name',
                                    {
                                        hint: true,
                                        error: errors.app_name,
                                    },
                                )}
                            />
                        </Field>

                        <Field
                            id="setup-app-url"
                            label={t('setup.basics.app_url')}
                            hint={t('setup.basics.app_url_hint')}
                            error={errors.app_url}
                        >
                            <Input
                                id="setup-app-url"
                                type="url"
                                name="app_url"
                                required
                                inputMode="url"
                                autoCapitalize="none"
                                spellCheck={false}
                                maxLength={LIMITS.appUrlLength}
                                defaultValue={defaults.app_url}
                                placeholder="https://chat.example.com"
                                aria-invalid={errors.app_url ? true : undefined}
                                aria-describedby={describedBy('setup-app-url', {
                                    hint: true,
                                    error: errors.app_url,
                                })}
                            />
                        </Field>

                        <div className="grid gap-5 sm:grid-cols-2">
                            <Field
                                id="setup-locale"
                                label={t('setup.basics.locale')}
                                error={errors.locale}
                            >
                                <NativeSelect
                                    id="setup-locale"
                                    name="locale"
                                    defaultValue={defaults.locale}
                                    aria-invalid={
                                        errors.locale ? true : undefined
                                    }
                                    aria-describedby={describedBy(
                                        'setup-locale',
                                        { error: errors.locale },
                                    )}
                                >
                                    {locales.map((locale) => (
                                        <option key={locale} value={locale}>
                                            {localeLabel(locale)}
                                        </option>
                                    ))}
                                </NativeSelect>
                            </Field>

                            <Field
                                id="setup-timezone"
                                label={t('setup.basics.timezone')}
                                error={errors.timezone}
                            >
                                <NativeSelect
                                    id="setup-timezone"
                                    name="timezone"
                                    defaultValue={canonicalTimeZone(
                                        defaults.timezone,
                                    )}
                                    aria-invalid={
                                        errors.timezone ? true : undefined
                                    }
                                    aria-describedby={describedBy(
                                        'setup-timezone',
                                        { error: errors.timezone },
                                    )}
                                >
                                    {timeZoneGroups.map((group) =>
                                        group.region === 'Other' ? (
                                            group.zones.map((zone) => (
                                                <option key={zone} value={zone}>
                                                    {zone}
                                                </option>
                                            ))
                                        ) : (
                                            <optgroup
                                                key={group.region}
                                                label={group.region}
                                            >
                                                {group.zones.map((zone) => (
                                                    <option
                                                        key={zone}
                                                        value={zone}
                                                    >
                                                        {formatTimeZone(zone)}
                                                    </option>
                                                ))}
                                            </optgroup>
                                        ),
                                    )}
                                </NativeSelect>
                            </Field>
                        </div>

                        <Field
                            id="setup-idle-timeout"
                            label={t('setup.basics.idle_timeout')}
                            hint={t('setup.basics.idle_timeout_hint', {
                                minutes: displayIdleTimeout(idleTimeout),
                            })}
                            error={
                                errors.idle_timeout_minutes ??
                                (idleInvalid
                                    ? t('setup.basics.idle_timeout_range', {
                                          min: IDLE_TIMEOUT.min,
                                          max: IDLE_TIMEOUT.max,
                                      })
                                    : undefined)
                            }
                        >
                            <Input
                                id="setup-idle-timeout"
                                type="number"
                                name="idle_timeout_minutes"
                                required
                                inputMode="numeric"
                                min={IDLE_TIMEOUT.min}
                                max={IDLE_TIMEOUT.max}
                                step={1}
                                value={idleTimeout}
                                onChange={(event) =>
                                    setIdleTimeout(event.target.value)
                                }
                                className="max-w-40"
                                aria-invalid={
                                    errors.idle_timeout_minutes || idleInvalid
                                        ? true
                                        : undefined
                                }
                                aria-describedby={describedBy(
                                    'setup-idle-timeout',
                                    {
                                        hint: true,
                                        error:
                                            errors.idle_timeout_minutes ??
                                            (idleInvalid ? 'range' : undefined),
                                    },
                                )}
                            />
                        </Field>
                    </div>
                </StepFrame>
            )}
        </Form>
    );
}
