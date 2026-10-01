import { useRef, useState, type FormEvent } from 'react';
import { useController, useSnapshot } from '@/embed/components/context';
import { NoticeBanner } from '@/embed/components/notice';
import { Button, Field, INPUT_CLASS } from '@/embed/components/ui';
import { formatNextOpen } from '@/embed/lib/format';
import {
    hasErrors,
    MAX_MESSAGE,
    validateOffline,
    type FieldErrorKeys,
} from '@/embed/session/flow';

/**
 * `offline`: nobody can answer (outside hours, no agent, or the queue ran out). With the offline form on, the visitor leaves a
 * message that becomes a ticket; with it off they are only told.
 */
export function OfflineScreen() {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const form = useRef<HTMLFormElement>(null);
    const [values, setValues] = useState({
        name: state.form.name,
        email: state.form.email,
        message: '',
        category:
            state.category ??
            (config?.categories.length === 1 ? config.categories[0].slug : ''),
    });
    const [errors, setErrors] = useState<FieldErrorKeys>({});
    const [edited, setEdited] = useState<Record<string, boolean>>({});

    if (config === null) {
        return null;
    }

    const reason = state.offline.reason;
    const next = config.availability?.nextOpenAt;
    const lead =
        reason === 'missed'
            ? t('embed.chat.offline.missed')
            : reason === 'hours' && next
              ? t('embed.chat.offline.next_open', {
                    time: formatNextOpen(next, config.locale, Date.now()),
                })
              : t('noAgents');

    if (!config.features.offlineForm) {
        return (
            <section className="pne-screen flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[20px] leading-snug font-semibold outline-none"
                >
                    {t('noAgents')}
                </h2>
                {reason === 'hours' && next ? (
                    <p className="text-subtle">{lead}</p>
                ) : null}
            </section>
        );
    }

    const message = (name: string): string | null => {
        const local = errors[name];

        if (local !== undefined) {
            return t(local);
        }

        return edited[name] ? null : (state.fieldErrors[name] ?? null);
    };

    const change = (name: keyof typeof values, value: string): void => {
        setValues((current) => ({ ...current, [name]: value }));
        setEdited((current) => ({ ...current, [name]: true }));
        setErrors((current) => {
            const { [name]: _removed, ...rest } = current;

            return rest;
        });
    };

    const submit = (event: FormEvent): void => {
        event.preventDefault();

        const found = validateOffline(values, config.categories.length > 1);

        setErrors(found);

        if (hasErrors(found)) {
            requestAnimationFrame(() =>
                form.current
                    ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                    ?.focus(),
            );

            return;
        }

        void controller.submitOffline(values);
    };

    const busy = state.busy === 'offline';

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col overflow-y-auto">
            <form
                ref={form}
                data-testid="offline-form"
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
                        {t('offlineTitle')}
                    </h2>
                    <p className="text-subtle">{lead}</p>
                    <p className="text-subtle">{t('offlineBody')}</p>
                </div>
                <NoticeBanner />
                <fieldset
                    disabled={busy}
                    className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
                >
                    <Field
                        label={t('embed.chat.field.name')}
                        error={message('name')}
                    >
                        {(a11y) => (
                            <input
                                {...a11y}
                                name="name"
                                autoComplete="name"
                                required
                                data-autofocus
                                className={INPUT_CLASS}
                                value={values.name}
                                onChange={(event) =>
                                    change('name', event.target.value)
                                }
                            />
                        )}
                    </Field>
                    <Field
                        label={t('embed.chat.field.email')}
                        error={message('email')}
                    >
                        {(a11y) => (
                            <input
                                {...a11y}
                                name="email"
                                type="email"
                                inputMode="email"
                                autoComplete="email"
                                required
                                className={INPUT_CLASS}
                                value={values.email}
                                onChange={(event) =>
                                    change('email', event.target.value)
                                }
                            />
                        )}
                    </Field>
                    {config.categories.length > 1 ? (
                        <Field
                            label={t('embed.chat.field.topic')}
                            error={message('category')}
                        >
                            {(a11y) => (
                                <select
                                    {...a11y}
                                    name="category"
                                    required
                                    className={INPUT_CLASS}
                                    value={values.category}
                                    onChange={(event) =>
                                        change('category', event.target.value)
                                    }
                                >
                                    <option value="" disabled />
                                    {config.categories.map((category) => (
                                        <option
                                            key={category.slug}
                                            value={category.slug}
                                        >
                                            {category.label}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </Field>
                    ) : null}
                    <Field
                        label={t('embed.chat.field.message')}
                        error={message('message')}
                    >
                        {(a11y) => (
                            <textarea
                                {...a11y}
                                name="message"
                                rows={4}
                                required
                                maxLength={MAX_MESSAGE}
                                className={`${INPUT_CLASS} resize-y`}
                                value={values.message}
                                onChange={(event) =>
                                    change('message', event.target.value)
                                }
                            />
                        )}
                    </Field>
                </fieldset>
                <Button type="submit" block busy={busy} className="mt-auto">
                    {t('embed.chat.offline.submit')}
                </Button>
            </form>
        </section>
    );
}
