import { useId } from 'react';
import { describedBy, Field } from '@/components/setup/field';
import { firstError, sectionAction } from '@/components/widgets/builder-state';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import { Notice, SectionCard, SwitchRow } from '@/components/widgets/form-bits';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/widget-config';
import type { FeaturesConfig, PreChatFieldKey } from '@/types/widgets';

const FEATURE_KEYS: (keyof FeaturesConfig)[] = [
    'attachments',
    'rating',
    'sounds',
    'preChat',
    'offlineForm',
    'endChatByVisitor',
    'titleBadge',
    'whatsapp',
    'poweredBy',
];

const PRE_CHAT_FIELDS: PreChatFieldKey[] = ['name', 'email', 'phone'];

export function FeaturesTab({ state, dispatch }: TabProps) {
    const { t } = useTrans();
    const uid = useId();
    const { features, preChat } = state.doc.config;
    const preChatOn = features.preChat;
    const consentError = firstError(state.errors, 'config.preChat.consentText');

    return (
        <div className="grid gap-5" data-testid="builder-panel-features">
            <SectionCard
                title={t('builder.features.title')}
                description={t('builder.features.description')}
            >
                <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
                    {FEATURE_KEYS.map((key) => (
                        <SwitchRow
                            key={key}
                            id={`${uid}-${key}`}
                            label={t(`builder.features.${key}`)}
                            description={t(`builder.features.${key}_hint`)}
                            checked={features[key]}
                            onCheckedChange={(checked) =>
                                dispatch(
                                    sectionAction('features', {
                                        [key]: checked,
                                    }),
                                )
                            }
                            testId={`builder-feature-${key}`}
                        />
                    ))}
                </div>
                {features.whatsapp && !state.meta.whatsappConnected && (
                    <Notice
                        tone="warning"
                        data-testid="builder-whatsapp-notice"
                    >
                        {t('builder.features.whatsapp_not_connected')}
                    </Notice>
                )}
            </SectionCard>

            <SectionCard
                title={t('builder.prechat.title')}
                description={t('builder.prechat.description')}
            >
                {!preChatOn && (
                    <Notice data-testid="builder-prechat-off">
                        {t('builder.prechat.off_notice')}
                    </Notice>
                )}

                <div
                    className="overflow-hidden rounded-lg border"
                    aria-disabled={!preChatOn}
                >
                    <div
                        aria-hidden
                        className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
                    >
                        <span>{t('builder.prechat.field')}</span>
                        <span>{t('builder.prechat.enabled')}</span>
                        <span>{t('builder.prechat.required')}</span>
                    </div>
                    <ul className="divide-y">
                        {PRE_CHAT_FIELDS.map((field) => {
                            const value = preChat.fields[field];
                            const enabledId = `${uid}-${field}-enabled`;
                            const requiredId = `${uid}-${field}-required`;

                            return (
                                <li
                                    key={field}
                                    className="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] items-center gap-3 px-3 py-2.5"
                                >
                                    <span className="text-sm font-medium">
                                        {t(`builder.prechat.field_${field}`)}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <Switch
                                            id={enabledId}
                                            checked={value.enabled}
                                            disabled={!preChatOn}
                                            aria-label={t(
                                                'builder.prechat.enable_field',
                                                {
                                                    field: t(
                                                        `builder.prechat.field_${field}`,
                                                    ),
                                                },
                                            )}
                                            onCheckedChange={(enabled) =>
                                                dispatch({
                                                    type: 'prechat/field',
                                                    field,
                                                    patch: enabled
                                                        ? { enabled }
                                                        : {
                                                              enabled,
                                                              required: false,
                                                          },
                                                })
                                            }
                                            data-testid={`builder-prechat-${field}-enabled`}
                                        />
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <Switch
                                            id={requiredId}
                                            checked={value.required}
                                            disabled={
                                                !preChatOn || !value.enabled
                                            }
                                            aria-label={t(
                                                'builder.prechat.require_field',
                                                {
                                                    field: t(
                                                        `builder.prechat.field_${field}`,
                                                    ),
                                                },
                                            )}
                                            onCheckedChange={(required) =>
                                                dispatch({
                                                    type: 'prechat/field',
                                                    field,
                                                    patch: { required },
                                                })
                                            }
                                            data-testid={`builder-prechat-${field}-required`}
                                        />
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </div>

                <Field
                    id={`${uid}-consent`}
                    label={t('builder.prechat.consent')}
                    hint={t('builder.prechat.consent_hint')}
                    error={consentError}
                >
                    <Textarea
                        id={`${uid}-consent`}
                        value={preChat.consentText ?? ''}
                        rows={2}
                        maxLength={LIMITS.consentLength}
                        disabled={!preChatOn}
                        onChange={(event) =>
                            dispatch({
                                type: 'prechat/consent',
                                text:
                                    event.target.value.trim() === ''
                                        ? null
                                        : event.target.value,
                            })
                        }
                        placeholder={t('builder.prechat.consent_placeholder')}
                        aria-invalid={consentError ? true : undefined}
                        aria-describedby={describedBy(`${uid}-consent`, {
                            hint: true,
                            error: consentError,
                        })}
                        data-testid="builder-prechat-consent"
                    />
                </Field>
            </SectionCard>
        </div>
    );
}
