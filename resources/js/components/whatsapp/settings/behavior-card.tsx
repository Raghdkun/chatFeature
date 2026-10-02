import { Save } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { describedBy, Field } from '@/components/setup/field';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    Busy,
    NumberField,
    Notice,
    SwitchRow,
} from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { isApiError } from '@/lib/api-client';
import { useWaApi } from '@/lib/realtime/whatsapp/use-wa-api';
import { describeWaError, durationLabel } from '@/lib/whatsapp-api/client';
import {
    WA_LIMITS,
    type WaSettings,
    type WaSettingsInput,
} from '@/lib/whatsapp-api/types';
import { handoffPreview, waMeUrl } from '@/lib/whatsapp/address';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

/** The sample code of the preview (the real ones are 8 characters from the same alphabet). */
const SAMPLE_CODE = 'K7M2QX4P';

const MB = 1024 * 1024;

type Form = Pick<
    WaSettings,
    | 'enabled'
    | 'handoffText'
    | 'handoffTtlMinutes'
    | 'ignoreGroups'
    | 'replyOnlyToInbound'
    | 'sendMinIntervalMs'
    | 'dailySendCap'
    | 'retentionDays'
    | 'rawRetentionDays'
> & { mediaMb: number };

const formOf = (settings: WaSettings): Form => ({
    enabled: settings.enabled,
    handoffText: settings.handoffText,
    handoffTtlMinutes: settings.handoffTtlMinutes,
    ignoreGroups: settings.ignoreGroups,
    replyOnlyToInbound: settings.replyOnlyToInbound,
    sendMinIntervalMs: settings.sendMinIntervalMs,
    dailySendCap: settings.dailySendCap,
    retentionDays: settings.retentionDays,
    rawRetentionDays: settings.rawRetentionDays,
    mediaMb: Math.max(1, Math.round(settings.mediaMaxBytes / MB)),
});

/** The server's field names (snake_case) of the form's fields, to put a `422` under the right input. */
const WIRE: Record<keyof Form, string> = {
    enabled: 'enabled',
    handoffText: 'handoff_text',
    handoffTtlMinutes: 'handoff_ttl_minutes',
    ignoreGroups: 'ignore_groups',
    replyOnlyToInbound: 'reply_only_to_inbound',
    sendMinIntervalMs: 'send_min_interval_ms',
    dailySendCap: 'daily_send_cap',
    retentionDays: 'retention_days',
    rawRetentionDays: 'raw_retention_days',
    mediaMb: 'media_max_bytes',
};

/**
 * How WhatsApp behaves: whether visitors are offered it, the hand-off text (with a live preview of the message and of the `wa.me` link),
 * how long a code lives, groups, who may be answered, and the sending limits that protect the number. Saved with one request that carries
 * only what changed; the server's validation messages land under the field they are about.
 */
export function BehaviorCard({
    settings,
    sessions,
    onSaved,
}: {
    settings: WaSettings;
    sessions: WhatsAppSession[];
    onSaved: (next: WaSettings) => void;
}) {
    const { t, locale } = useTrans();
    const api = useWaApi();
    const uid = useId();
    const [form, setForm] = useState<Form>(() => formOf(settings));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [problem, setProblem] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const saved = useMemo(() => formOf(settings), [settings]);
    const changed = (Object.keys(form) as (keyof Form)[]).filter(
        (key) => form[key] !== saved[key],
    );
    const dirty = changed.length > 0;
    const preview = handoffPreview(form.handoffText, SAMPLE_CODE);
    const number = sessions.find((s) => s.status === 'ready')?.phone ?? null;
    const link = waMeUrl(number, preview);

    const set = <K extends keyof Form>(key: K, value: Form[K]): void => {
        setForm((held) => ({ ...held, [key]: value }));
        setProblem(null);
        setErrors((held) => {
            const copy = { ...held };

            delete copy[WIRE[key]];

            return copy;
        });
    };

    const handoffError = (): string | undefined => {
        if (form.handoffText.trim() === '') {
            return t('whatsapp.behavior.error.handoff_required');
        }

        if (!form.handoffText.includes(':code')) {
            return t('whatsapp.behavior.error.handoff_code');
        }

        if (/[\r\n]/.test(form.handoffText)) {
            return t('whatsapp.behavior.error.handoff_line');
        }

        return undefined;
    };

    const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        if (saving || !dirty) {
            return;
        }

        const found: Record<string, string> = {};
        const text = handoffError();

        if (text !== undefined) {
            found[WIRE.handoffText] = text;
        }

        setErrors(found);

        if (Object.keys(found).length > 0) {
            return;
        }

        const input: WaSettingsInput = {};

        for (const key of changed) {
            if (key === 'mediaMb') {
                input.mediaMaxBytes = form.mediaMb * MB;
            } else {
                Object.assign(input, { [key]: form[key] });
            }
        }

        setSaving(true);
        setProblem(null);

        try {
            const next = await api.saveSettings(input);

            onSaved(next);
            setForm(formOf(next));
            toast.success(t('whatsapp.behavior.saved'));
        } catch (error) {
            if (isApiError(error) && error.isValidation) {
                const mapped: Record<string, string> = {};

                for (const [field, messages] of Object.entries(error.details)) {
                    mapped[field] = messages[0] ?? '';
                }

                setErrors(mapped);

                if (
                    !Object.keys(mapped).some((field) =>
                        Object.values(WIRE).includes(field),
                    )
                ) {
                    setProblem(describeWaError(error, t, locale));
                }
            } else {
                setProblem(describeWaError(error, t, locale));
            }
        } finally {
            setSaving(false);
        }
    };

    const text = errors[WIRE.handoffText] ?? undefined;
    const textId = `${uid}-handoff`;

    return (
        <Card
            role="region"
            aria-labelledby="wa-behavior-title"
            data-testid="wa-behavior-card"
        >
            <CardHeader>
                <CardTitle id="wa-behavior-title" role="heading" aria-level={2}>
                    {t('whatsapp.behavior.title')}
                </CardTitle>
                <CardDescription>
                    {t('whatsapp.behavior.description')}
                </CardDescription>
            </CardHeader>

            <form
                onSubmit={(event) => void save(event)}
                noValidate
                data-testid="wa-behavior-form"
                className="grid gap-6"
            >
                <CardContent className="grid gap-6">
                    {problem && (
                        <Notice tone="danger" data-testid="wa-behavior-problem">
                            {problem}
                        </Notice>
                    )}

                    <SwitchRow
                        id={`${uid}-enabled`}
                        label={t('whatsapp.behavior.enabled')}
                        description={t('whatsapp.behavior.enabled_hint')}
                        checked={form.enabled}
                        disabled={saving}
                        testId="wa-setting-enabled"
                        onCheckedChange={(value) => set('enabled', value)}
                    />

                    <div className="grid gap-3">
                        <Field
                            id={textId}
                            label={t('whatsapp.behavior.handoff_text')}
                            hint={t('whatsapp.behavior.handoff_text_hint')}
                            error={text}
                        >
                            <Input
                                id={textId}
                                data-testid="wa-setting-handoff-text"
                                value={form.handoffText}
                                maxLength={WA_LIMITS.handoffTextMax}
                                disabled={saving}
                                aria-invalid={text ? true : undefined}
                                aria-describedby={describedBy(textId, {
                                    hint: true,
                                    error: text,
                                })}
                                onChange={(event) =>
                                    set('handoffText', event.target.value)
                                }
                            />
                        </Field>
                        <div
                            data-testid="wa-handoff-preview"
                            className="grid gap-1.5 rounded-lg border bg-muted/40 p-3 text-sm"
                        >
                            <p className="text-xs font-medium text-muted-foreground">
                                {t('whatsapp.behavior.preview')}
                            </p>
                            <p
                                dir="auto"
                                data-testid="wa-handoff-message"
                                className="[overflow-wrap:anywhere]"
                            >
                                {preview}
                            </p>
                            {link ? (
                                <p
                                    dir="ltr"
                                    data-testid="wa-handoff-link"
                                    className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground"
                                >
                                    {link}
                                </p>
                            ) : (
                                <p
                                    data-testid="wa-handoff-no-number"
                                    className="text-xs text-muted-foreground"
                                >
                                    {t('whatsapp.behavior.preview_no_number')}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="grid gap-6 sm:grid-cols-2">
                        <NumberField
                            id={`${uid}-ttl`}
                            label={t('whatsapp.behavior.ttl')}
                            value={form.handoffTtlMinutes}
                            min={WA_LIMITS.handoffTtlMinutes.min}
                            max={WA_LIMITS.handoffTtlMinutes.max}
                            suffix={t('whatsapp.behavior.minutes')}
                            hint={t('whatsapp.behavior.ttl_hint', {
                                wait: durationLabel(
                                    form.handoffTtlMinutes * 60,
                                    locale,
                                ),
                            })}
                            error={errors[WIRE.handoffTtlMinutes]}
                            disabled={saving}
                            onValueChange={(value) =>
                                set('handoffTtlMinutes', value)
                            }
                        />
                        <NumberField
                            id={`${uid}-media`}
                            label={t('whatsapp.behavior.media')}
                            value={form.mediaMb}
                            min={1}
                            max={WA_LIMITS.mediaMaxBytes.max / MB}
                            suffix={t('whatsapp.behavior.megabytes')}
                            hint={t('whatsapp.behavior.media_hint')}
                            error={errors[WIRE.mediaMb]}
                            disabled={saving}
                            onValueChange={(value) => set('mediaMb', value)}
                        />
                        <NumberField
                            id={`${uid}-retention`}
                            label={t('whatsapp.behavior.retention')}
                            value={form.retentionDays}
                            min={WA_LIMITS.retentionDays.min}
                            max={WA_LIMITS.retentionDays.max}
                            suffix={t('whatsapp.behavior.days')}
                            hint={t('whatsapp.behavior.retention_hint')}
                            error={errors[WIRE.retentionDays]}
                            disabled={saving}
                            onValueChange={(value) =>
                                set('retentionDays', value)
                            }
                        />
                        <NumberField
                            id={`${uid}-raw-retention`}
                            label={t('whatsapp.behavior.raw_retention')}
                            value={form.rawRetentionDays}
                            min={WA_LIMITS.rawRetentionDays.min}
                            max={WA_LIMITS.rawRetentionDays.max}
                            suffix={t('whatsapp.behavior.days')}
                            hint={t('whatsapp.behavior.raw_retention_hint')}
                            error={errors[WIRE.rawRetentionDays]}
                            disabled={saving}
                            onValueChange={(value) =>
                                set('rawRetentionDays', value)
                            }
                        />
                    </div>

                    <SwitchRow
                        id={`${uid}-groups`}
                        label={t('whatsapp.behavior.ignore_groups')}
                        description={t('whatsapp.behavior.ignore_groups_hint')}
                        checked={form.ignoreGroups}
                        disabled={saving}
                        testId="wa-setting-ignore-groups"
                        onCheckedChange={(value) => set('ignoreGroups', value)}
                    />
                    <SwitchRow
                        id={`${uid}-inbound`}
                        label={t('whatsapp.behavior.reply_inbound')}
                        description={t('whatsapp.behavior.reply_inbound_hint')}
                        checked={form.replyOnlyToInbound}
                        disabled={saving}
                        testId="wa-setting-reply-inbound"
                        onCheckedChange={(value) =>
                            set('replyOnlyToInbound', value)
                        }
                    />
                    {!form.replyOnlyToInbound && (
                        <Notice tone="warning" data-testid="wa-inbound-warning">
                            {t('whatsapp.behavior.reply_inbound_warning')}
                        </Notice>
                    )}

                    <div className="grid gap-6 sm:grid-cols-2">
                        <NumberField
                            id={`${uid}-interval`}
                            label={t('whatsapp.behavior.interval')}
                            value={form.sendMinIntervalMs}
                            min={WA_LIMITS.sendMinIntervalMs.min}
                            max={WA_LIMITS.sendMinIntervalMs.max}
                            suffix={t('whatsapp.behavior.milliseconds')}
                            hint={t('whatsapp.behavior.interval_hint')}
                            error={errors[WIRE.sendMinIntervalMs]}
                            disabled={saving}
                            onValueChange={(value) =>
                                set('sendMinIntervalMs', value)
                            }
                        />
                        <NumberField
                            id={`${uid}-cap`}
                            label={t('whatsapp.behavior.cap')}
                            value={form.dailySendCap}
                            min={WA_LIMITS.dailySendCap.min}
                            max={WA_LIMITS.dailySendCap.max}
                            suffix={t('whatsapp.behavior.per_day')}
                            hint={t('whatsapp.behavior.cap_hint')}
                            error={errors[WIRE.dailySendCap]}
                            disabled={saving}
                            onValueChange={(value) =>
                                set('dailySendCap', value)
                            }
                        />
                    </div>
                </CardContent>

                <CardFooter>
                    <Button
                        type="submit"
                        disabled={!dirty || saving}
                        data-testid="wa-behavior-save"
                    >
                        {saving ? <Busy /> : <Save aria-hidden />}
                        {t('whatsapp.behavior.save')}
                    </Button>
                </CardFooter>
            </form>
        </Card>
    );
}
