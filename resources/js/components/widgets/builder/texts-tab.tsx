import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { describedBy, Field } from '@/components/setup/field';
import { firstError, errorsUnder } from '@/components/widgets/builder-state';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import {
    FieldSet,
    SectionCard,
    SegmentedChoice,
    SwitchRow,
} from '@/components/widgets/form-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTrans } from '@/hooks/use-trans';
import { directionFor, localeLabel } from '@/lib/i18n';
import { LIMITS, LOCALE_CODE_LENGTH } from '@/lib/limits';
import {
    configLocales,
    DEFAULT_TEXTS_EN,
    isLocaleCode,
    LOCALE_SUGGESTIONS,
    LONG_TEXT_KEYS,
    resolveText,
    TEXT_KEYS,
} from '@/lib/widget-config';

/** Every string the widget shows, per language. Empty = fall back to the default language, then English. */
export function TextsTab({ state, dispatch }: TabProps) {
    const { t } = useTrans();
    const uid = useId();
    const { config } = state.doc;
    const locales = configLocales(config);
    const [picked, setPicked] = useState(config.defaultLocale);
    // The picked locale may have been removed (or the default changed): fall back to the default.
    const locale = locales.includes(picked) ? picked : config.defaultLocale;
    const block = config.texts[locale] ?? {};
    const isDefault = locale === config.defaultLocale;
    const translated = TEXT_KEYS.filter(
        (key) => (block[key] ?? '') !== '',
    ).length;
    const dir = directionFor(locale);

    const [draftCode, setDraftCode] = useState('');
    const [addError, setAddError] = useState<string | undefined>();

    function addLocale() {
        const code = draftCode.trim();

        if (!isLocaleCode(code)) {
            setAddError(t('builder.validation.locale'));

            return;
        }

        if (locales.includes(code)) {
            setAddError(t('builder.texts.locale_exists'));

            return;
        }

        dispatch({ type: 'texts/add-locale', locale: code });
        setPicked(code);
        setDraftCode('');
        setAddError(undefined);
    }

    return (
        <div className="grid gap-5" data-testid="builder-panel-texts">
            <SectionCard
                title={t('builder.texts.languages_title')}
                description={t('builder.texts.languages_description')}
            >
                <SegmentedChoice
                    legend={t('builder.texts.language')}
                    name={`${uid}-locale`}
                    value={locale}
                    onChange={setPicked}
                    options={locales.map((code) => ({
                        value: code,
                        label:
                            code === config.defaultLocale
                                ? `${localeLabel(code)} · ${t('builder.texts.default_badge')}`
                                : localeLabel(code),
                    }))}
                    testId="builder-texts-locales"
                />

                <FieldSet
                    legend={t('builder.texts.add_language')}
                    error={addError ?? firstError(state.errors, 'config.texts')}
                >
                    <datalist id={`${uid}-suggestions`}>
                        {LOCALE_SUGGESTIONS.filter(
                            (code) => !locales.includes(code),
                        ).map((code) => (
                            <option key={code} value={code} />
                        ))}
                    </datalist>
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={draftCode}
                            list={`${uid}-suggestions`}
                            onChange={(event) => {
                                setDraftCode(event.target.value);
                                setAddError(undefined);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    addLocale();
                                }
                            }}
                            aria-label={t('builder.texts.language_code')}
                            placeholder="ar, fr, pt-BR"
                            maxLength={LOCALE_CODE_LENGTH}
                            dir="ltr"
                            spellCheck={false}
                            autoComplete="off"
                            data-testid="builder-texts-add-input"
                            className="max-w-40 font-mono text-sm"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={addLocale}
                            data-testid="builder-texts-add"
                        >
                            <Plus aria-hidden />
                            {t('builder.texts.add')}
                        </Button>
                    </div>
                </FieldSet>

                <SwitchRow
                    id={`${uid}-detect`}
                    label={t('builder.general.locale_detect')}
                    description={t('builder.general.locale_detect_hint')}
                    checked={config.localeDetect}
                    onCheckedChange={(value) =>
                        dispatch({
                            type: 'config/root',
                            patch: { localeDetect: value },
                        })
                    }
                    testId="builder-locale-detect"
                />
            </SectionCard>

            <SectionCard
                title={localeLabel(locale)}
                description={
                    isDefault
                        ? t('builder.texts.default_description')
                        : t('builder.texts.progress', {
                              done: translated,
                              total: TEXT_KEYS.length,
                          })
                }
                actions={
                    !isDefault && (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive-foreground hover:text-destructive-foreground"
                            data-testid="builder-texts-remove"
                            onClick={() =>
                                dispatch({
                                    type: 'texts/remove-locale',
                                    locale,
                                })
                            }
                        >
                            <Trash2 aria-hidden />
                            {t('builder.texts.remove_language')}
                        </Button>
                    )
                }
                testId={`builder-texts-${locale}`}
            >
                {errorsUnder(state.errors, `config.texts.${locale}`).map(
                    (message) => (
                        <p
                            key={message}
                            className="text-sm text-red-600 dark:text-red-400"
                        >
                            {message}
                        </p>
                    ),
                )}
                <div className="grid gap-5 sm:grid-cols-2">
                    {TEXT_KEYS.map((key) => {
                        const id = `${uid}-${locale}-${key}`;
                        const placeholder = isDefault
                            ? DEFAULT_TEXTS_EN[key]
                            : resolveText(config, config.defaultLocale, key);
                        const long = LONG_TEXT_KEYS.has(key);
                        const error = firstError(
                            state.errors,
                            `config.texts.${locale}.${key}`,
                        );
                        const common = {
                            id,
                            value: block[key] ?? '',
                            placeholder,
                            dir,
                            'aria-invalid': error ? (true as const) : undefined,
                            'aria-describedby': describedBy(id, { error }),
                            'data-testid': `builder-text-${key}`,
                        };
                        const onValue = (value: string) =>
                            dispatch({ type: 'texts/set', locale, key, value });

                        return (
                            <div
                                key={key}
                                className={long ? 'sm:col-span-2' : undefined}
                            >
                                <Field
                                    id={id}
                                    label={t(`builder.texts.key.${key}`)}
                                    error={error}
                                >
                                    {long ? (
                                        <Textarea
                                            {...common}
                                            rows={2}
                                            maxLength={LIMITS.textLength}
                                            onChange={(event) =>
                                                onValue(event.target.value)
                                            }
                                        />
                                    ) : (
                                        <Input
                                            {...common}
                                            maxLength={LIMITS.textLength}
                                            onChange={(event) =>
                                                onValue(event.target.value)
                                            }
                                        />
                                    )}
                                </Field>
                            </div>
                        );
                    })}
                </div>
                {!isDefault && (
                    <p className="text-sm text-muted-foreground">
                        {t('builder.texts.fallback_hint', {
                            language: localeLabel(config.defaultLocale),
                        })}
                    </p>
                )}
            </SectionCard>
        </div>
    );
}
