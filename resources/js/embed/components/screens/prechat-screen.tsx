import { useRef, useState, type FormEvent } from 'react';
import { useController, useSnapshot } from '@/embed/components/context';
import { NoticeBanner } from '@/embed/components/notice';
import { Button, Field, INPUT_CLASS } from '@/embed/components/ui';
import {
    PRECHAT_FIELDS,
    type PreChatFieldName,
} from '@/embed/config/panel-config';
import {
    hasErrors,
    validatePreChat,
    type FieldErrorKeys,
} from '@/embed/session/flow';
import type { MessageKey } from '@/embed/i18n';

const LABEL: Record<PreChatFieldName, MessageKey> = {
    name: 'embed.chat.field.name',
    email: 'embed.chat.field.email',
    phone: 'embed.chat.field.phone',
};

const INPUT_TYPE: Record<PreChatFieldName, 'text' | 'email' | 'tel'> = {
    name: 'text',
    email: 'email',
    phone: 'tel',
};

const AUTOCOMPLETE: Record<PreChatFieldName, string> = {
    name: 'name',
    email: 'email',
    phone: 'tel',
};

/** `prechat`: the fields the widget config asks for (required / optional) and the consent checkbox. */
export function PrechatScreen() {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const form = useRef<HTMLFormElement>(null);
    const [values, setValues] = useState(state.form);
    const [errors, setErrors] = useState<FieldErrorKeys>({});
    const [edited, setEdited] = useState<Record<string, boolean>>({});

    if (config === null) {
        return null;
    }

    const message = (name: string): string | null => {
        const local = errors[name];

        if (local !== undefined) {
            return t(local);
        }

        return edited[name] ? null : (state.fieldErrors[name] ?? null);
    };

    const change = (
        name: keyof typeof values,
        value: string | boolean,
    ): void => {
        setValues((current) => ({ ...current, [name]: value }));
        setEdited((current) => ({ ...current, [name]: true }));
        setErrors((current) => {
            const { [name]: _removed, ...rest } = current;

            return rest;
        });
    };

    const submit = (event: FormEvent): void => {
        event.preventDefault();

        const found = validatePreChat(config, values);

        setErrors(found);

        if (hasErrors(found)) {
            requestAnimationFrame(() =>
                form.current
                    ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                    ?.focus(),
            );

            return;
        }

        controller.submitPrechat(values);
    };

    const busy = state.busy === 'starting';
    const consent = config.preChat.consentText;
    const consentError = message('consent');
    const firstField = PRECHAT_FIELDS.find(
        (name) => config.preChat.fields[name].enabled,
    );

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col overflow-y-auto">
            <form
                ref={form}
                data-testid="prechat-form"
                noValidate
                onSubmit={submit}
                className="flex flex-1 flex-col gap-4 p-5"
            >
                <div className="flex flex-col gap-1">
                    <h2
                        data-screen-title
                        tabIndex={-1}
                        className="text-[20px] leading-snug font-semibold outline-none"
                    >
                        {t('embed.chat.prechat.title')}
                    </h2>
                    <p className="text-subtle">{t('welcome')}</p>
                </div>
                <NoticeBanner />
                <fieldset
                    disabled={busy}
                    className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
                >
                    {PRECHAT_FIELDS.filter(
                        (name) => config.preChat.fields[name].enabled,
                    ).map((name) => (
                        <Field
                            key={name}
                            label={t(LABEL[name])}
                            optionalLabel={
                                config.preChat.fields[name].required
                                    ? null
                                    : t('embed.chat.field.optional')
                            }
                            error={message(name)}
                        >
                            {(a11y) => (
                                <input
                                    {...a11y}
                                    name={name}
                                    type={INPUT_TYPE[name]}
                                    autoComplete={AUTOCOMPLETE[name]}
                                    inputMode={
                                        name === 'phone'
                                            ? 'tel'
                                            : name === 'email'
                                              ? 'email'
                                              : undefined
                                    }
                                    required={
                                        config.preChat.fields[name].required
                                    }
                                    data-autofocus={
                                        name === firstField ? true : undefined
                                    }
                                    className={INPUT_CLASS}
                                    value={values[name]}
                                    onChange={(event) =>
                                        change(name, event.target.value)
                                    }
                                />
                            )}
                        </Field>
                    ))}
                    {consent !== null ? (
                        <div className="flex flex-col gap-1.5">
                            <label className="flex cursor-pointer items-start gap-3 text-[14px]">
                                <input
                                    type="checkbox"
                                    name="consent"
                                    checked={values.consent}
                                    onChange={(event) =>
                                        change('consent', event.target.checked)
                                    }
                                    aria-invalid={
                                        consentError ? true : undefined
                                    }
                                    aria-describedby={
                                        consentError
                                            ? 'pne-consent-error'
                                            : undefined
                                    }
                                    className="accent-brand mt-0.5 size-5 shrink-0"
                                />
                                <span>{consent}</span>
                            </label>
                            {consentError ? (
                                <p
                                    id="pne-consent-error"
                                    className="text-danger text-[13px]"
                                >
                                    {consentError}
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                </fieldset>
                <Button type="submit" block busy={busy} className="mt-auto">
                    {t('embed.chat.prechat.submit')}
                </Button>
            </form>
        </section>
    );
}
