import { CircleCheck } from 'lucide-react';
import PasswordInput from '@/components/password-input';
import { describedBy, Field } from '@/components/setup/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/limits';
import { cn } from '@/lib/utils';
import { DEFAULT_SERVICE_NAME, type EnvFormValues } from '@/lib/pizzasys-form';

/** Server field names an environment form can show an error under. */
export type EnvErrorField =
    | 'label'
    | 'base_url'
    | 'service_name'
    | 'service_token'
    | 'nats_url'
    | 'nats_token'
    | 'verify_tls';

/**
 * The fields of one Auth Portal environment: base URL, service client name and token, optional
 * NATS and TLS verification. Shared by the wizard and Settings > Auth. Secrets are write-only:
 * the inputs start empty, a saved secret is only indicated ("Token saved"), and leaving one blank
 * keeps what is stored.
 *
 * Every control id (and `data-testid`) is `<idPrefix>-<field>`, e.g. `setup-env-production-base-url`.
 */
export function PizzasysEnvironmentFields({
    idPrefix,
    values,
    onChange,
    hasServiceToken = false,
    hasNatsToken = false,
    error,
    showLabel = false,
    allowClearNatsToken = false,
    disabled = false,
    autoFocus = false,
    layout = 'split',
}: {
    idPrefix: string;
    values: EnvFormValues;
    onChange: (patch: Partial<EnvFormValues>) => void;
    /** A service token is already stored (only the flag ever reaches the browser). */
    hasServiceToken?: boolean;
    hasNatsToken?: boolean;
    error: (field: EnvErrorField) => string | undefined;
    showLabel?: boolean;
    allowClearNatsToken?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
    /** `split` puts related fields side by side from `sm` up; `stacked` keeps one column (narrow hosts). */
    layout?: 'split' | 'stacked';
}) {
    const { t } = useTrans();
    const pair = layout === 'split' ? 'sm:grid-cols-2' : '';
    const hasToken = hasServiceToken;
    const id = (field: string) => `${idPrefix}-${field}`;
    const props = (field: string, name: EnvErrorField, hint = false) => ({
        id: id(field),
        'data-testid': id(field),
        disabled,
        'aria-invalid': error(name) ? (true as const) : undefined,
        'aria-describedby': describedBy(id(field), {
            hint,
            error: error(name),
        }),
    });

    return (
        <div className="grid gap-5">
            {showLabel && (
                <Field
                    id={id('label')}
                    label={t('setup.pizzasys.label')}
                    hint={t('setup.pizzasys.label_hint')}
                    error={error('label')}
                >
                    <Input
                        {...props('label', 'label', true)}
                        value={values.label}
                        maxLength={LIMITS.portalLabelLength}
                        onChange={(event) =>
                            onChange({ label: event.target.value })
                        }
                    />
                </Field>
            )}

            <Field
                id={id('base-url')}
                label={t('setup.pizzasys.base_url')}
                hint={t('setup.pizzasys.base_url_hint')}
                error={error('base_url')}
            >
                <Input
                    {...props('base-url', 'base_url', true)}
                    dir="ltr"
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={autoFocus}
                    placeholder="https://auth.example.com"
                    value={values.base_url}
                    onChange={(event) =>
                        onChange({ base_url: event.target.value })
                    }
                />
            </Field>

            <div className={cn('grid gap-5', pair)}>
                <Field
                    id={id('service-name')}
                    label={t('setup.pizzasys.service_name')}
                    hint={t('setup.pizzasys.service_name_hint')}
                    error={error('service_name')}
                >
                    <Input
                        {...props('service-name', 'service_name', true)}
                        dir="ltr"
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={LIMITS.serviceNameLength}
                        placeholder={DEFAULT_SERVICE_NAME}
                        value={values.service_name}
                        onChange={(event) =>
                            onChange({ service_name: event.target.value })
                        }
                    />
                </Field>

                <Field
                    id={id('service-token')}
                    label={t('setup.pizzasys.service_token')}
                    hint={
                        hasToken ? (
                            <>
                                <span
                                    className="inline-flex items-center gap-1 font-medium text-foreground"
                                    data-testid={id('service-token-saved')}
                                >
                                    <CircleCheck
                                        className="size-3.5 text-primary"
                                        aria-hidden
                                    />
                                    {t('setup.pizzasys.token_saved')}
                                </span>{' '}
                                {t('setup.pizzasys.token_keep_hint')}
                            </>
                        ) : (
                            t('setup.pizzasys.service_token_hint')
                        )
                    }
                    error={error('service_token')}
                >
                    <PasswordInput
                        {...props('service-token', 'service_token', true)}
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={hasToken ? '••••••••' : undefined}
                        maxLength={LIMITS.secretLength}
                        value={values.service_token}
                        onChange={(event) =>
                            onChange({ service_token: event.target.value })
                        }
                    />
                </Field>
            </div>

            <fieldset className="grid gap-5 rounded-lg border border-dashed p-4">
                <legend className="px-1.5 text-sm font-medium">
                    {t('setup.pizzasys.nats_legend')}
                </legend>
                <p className="-mt-2 text-sm text-muted-foreground">
                    {t('setup.pizzasys.nats_description')}
                </p>

                <div className={cn('grid gap-5', pair)}>
                    <Field
                        id={id('nats-url')}
                        label={t('setup.pizzasys.nats_url')}
                        error={error('nats_url')}
                    >
                        <Input
                            {...props('nats-url', 'nats_url')}
                            dir="ltr"
                            inputMode="url"
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="nats://nats.example.com:4222"
                            value={values.nats_url}
                            onChange={(event) =>
                                onChange({ nats_url: event.target.value })
                            }
                        />
                    </Field>

                    <Field
                        id={id('nats-token')}
                        label={t('setup.pizzasys.nats_token')}
                        hint={
                            hasNatsToken ? (
                                <>
                                    <span
                                        className="inline-flex items-center gap-1 font-medium text-foreground"
                                        data-testid={id('nats-token-saved')}
                                    >
                                        <CircleCheck
                                            className="size-3.5 text-primary"
                                            aria-hidden
                                        />
                                        {t('setup.pizzasys.token_saved')}
                                    </span>{' '}
                                    {t('setup.pizzasys.token_keep_hint')}
                                </>
                            ) : undefined
                        }
                        error={error('nats_token')}
                    >
                        <PasswordInput
                            {...props('nats-token', 'nats_token', hasNatsToken)}
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={disabled || values.clear_nats_token}
                            maxLength={LIMITS.secretLength}
                            value={values.nats_token}
                            onChange={(event) =>
                                onChange({ nats_token: event.target.value })
                            }
                        />
                    </Field>
                </div>

                {allowClearNatsToken && hasNatsToken && (
                    <div className="flex items-center gap-3">
                        <Checkbox
                            id={id('nats-token-clear')}
                            data-testid={id('nats-token-clear')}
                            checked={values.clear_nats_token}
                            disabled={disabled}
                            onCheckedChange={(checked) =>
                                onChange({
                                    clear_nats_token: checked === true,
                                    nats_token: '',
                                })
                            }
                        />
                        <Label htmlFor={id('nats-token-clear')}>
                            {t('setup.pizzasys.nats_token_clear')}
                        </Label>
                    </div>
                )}
            </fieldset>

            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                <div className="grid gap-1">
                    <Label htmlFor={id('verify-tls')}>
                        {t('setup.pizzasys.verify_tls')}
                    </Label>
                    <p
                        id={`${id('verify-tls')}-hint`}
                        className="text-sm text-muted-foreground"
                    >
                        {t('setup.pizzasys.verify_tls_hint')}
                    </p>
                    {!values.verify_tls && (
                        <p
                            className="text-sm font-medium text-amber-700 dark:text-amber-400"
                            data-testid={id('verify-tls-warning')}
                        >
                            {t('setup.pizzasys.verify_tls_off_warning')}
                        </p>
                    )}
                </div>
                <Switch
                    id={id('verify-tls')}
                    data-testid={id('verify-tls')}
                    // The shared switch moves its thumb with a physical offset: keep it left to right.
                    dir="ltr"
                    checked={values.verify_tls}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                        onChange({ verify_tls: checked })
                    }
                    aria-describedby={`${id('verify-tls')}-hint`}
                />
            </div>
        </div>
    );
}
