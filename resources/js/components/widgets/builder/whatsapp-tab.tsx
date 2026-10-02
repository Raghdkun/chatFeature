import { Link } from '@inertiajs/react';
import { Check, TriangleAlert, X } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { describedBy, Field } from '@/components/setup/field';
import { NativeSelect } from '@/components/setup/native-select';
import { sectionAction } from '@/components/widgets/builder-state';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import { useWhatsAppLink } from '@/components/widgets/builder/use-whatsapp-link';
import { Notice, SectionCard, SwitchRow } from '@/components/widgets/form-bits';
import { PhoneNumber } from '@/components/whatsapp/phone-number';
import { SessionStatusBadge } from '@/components/whatsapp/session-status';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { isApiError } from '@/lib/api-client';
import { describeWaError } from '@/lib/whatsapp-api/client';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import { handoffPreview, waMeUrl } from '@/lib/whatsapp/address';
import { cn } from '@/lib/utils';

/** The sample code of the preview (the real ones are 8 characters from the same alphabet). */
const SAMPLE_CODE = 'K7M2QX4P';

function CheckRow({
    ok,
    label,
    testId,
}: {
    ok: boolean;
    label: string;
    testId: string;
}) {
    const { t } = useTrans();

    return (
        <li
            data-testid={testId}
            data-ok={ok ? 'true' : 'false'}
            className="flex items-start gap-2 text-sm"
        >
            {ok ? (
                <Check
                    className="mt-0.5 size-4 shrink-0 text-emerald-600"
                    aria-hidden
                />
            ) : (
                <X
                    className="mt-0.5 size-4 shrink-0 text-red-600"
                    aria-hidden
                />
            )}
            <span>
                {label}
                <span className="sr-only">
                    {' '}
                    {t(
                        ok
                            ? 'whatsapp.builder.check_yes'
                            : 'whatsapp.builder.check_no',
                    )}
                </span>
            </span>
        </li>
    );
}

type Ready = Extract<
    ReturnType<typeof useWhatsAppLink>['state'],
    { status: 'ready' }
>;

/** The loaded part of the session card: the picker, the chosen session's state, the preview, and the checklist of why visitors do or do not see WhatsApp. */
function ReadyView({
    link,
    sessions,
    settings,
    published,
    draftOn,
    saving,
    error,
    onChoose,
}: Pick<Ready, 'link' | 'sessions' | 'settings'> & {
    /** The widget's PUBLISHED `features.whatsapp`: what visitors get today. */
    published: boolean;
    /** The draft's `features.whatsapp`: what Publish will make of it. */
    draftOn: boolean;
    saving: boolean;
    error: string | undefined;
    onChoose: (sessionUlid: string) => void;
}) {
    const { t } = useTrans();
    const uid = useId();
    const current = link.session?.ulid ?? '';
    const ready = sessions.filter((s) => s.status === 'ready');
    const linked = sessions.find((s) => s.ulid === current);
    const options = [
        ...ready,
        ...(linked && linked.status !== 'ready' ? [linked] : []),
    ];
    const preview = handoffPreview(settings.handoffText, SAMPLE_CODE);
    const url = waMeUrl(linked?.phone ?? null, preview);
    const serves = link.connected;

    return (
        <>
            {ready.length === 0 && (
                <Notice
                    tone="warning"
                    data-testid="builder-whatsapp-no-session"
                >
                    {t('whatsapp.builder.no_session')}{' '}
                    <Link
                        href={waRoutes.pages.settings()}
                        className="font-medium underline underline-offset-2"
                    >
                        {t('whatsapp.builder.open_settings')}
                    </Link>
                </Notice>
            )}

            <Field
                id={`${uid}-session`}
                label={t('whatsapp.builder.session')}
                hint={t('whatsapp.builder.session_hint')}
                error={error}
            >
                <NativeSelect
                    id={`${uid}-session`}
                    data-testid="builder-whatsapp-session"
                    value={current}
                    disabled={saving}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(`${uid}-session`, {
                        hint: true,
                        error,
                    })}
                    onChange={(event) => onChoose(event.target.value)}
                >
                    <option value="">{t('whatsapp.builder.none')}</option>
                    {options.map((session) => (
                        <option key={session.ulid} value={session.ulid}>
                            {session.name}
                            {session.status !== 'ready'
                                ? ` (${t(`whatsapp.status.${session.status}`)})`
                                : session.maskedPhone
                                  ? ` · ${session.maskedPhone}`
                                  : ''}
                        </option>
                    ))}
                </NativeSelect>
            </Field>

            {link.session && (
                <div
                    data-testid="builder-whatsapp-status"
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm"
                >
                    <span className="font-medium" dir="ltr">
                        {link.session.name}
                    </span>
                    {link.status && <SessionStatusBadge status={link.status} />}
                    <PhoneNumber
                        phone={null}
                        masked={link.maskedPhone}
                        testId="builder-whatsapp-number"
                    />
                </div>
            )}

            <div
                data-testid="builder-whatsapp-preview"
                className="grid gap-1.5 rounded-lg border p-3 text-sm"
            >
                <p className="text-xs font-medium text-muted-foreground">
                    {t('whatsapp.builder.preview')}
                </p>
                <p
                    dir="auto"
                    data-testid="builder-whatsapp-message"
                    className="[overflow-wrap:anywhere]"
                >
                    {preview}
                </p>
                {url ? (
                    <p
                        dir="ltr"
                        data-testid="builder-whatsapp-link"
                        className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground"
                    >
                        {url}
                    </p>
                ) : (
                    <p
                        data-testid="builder-whatsapp-no-link"
                        className="text-xs text-muted-foreground"
                    >
                        {t('whatsapp.builder.preview_no_link')}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    {t('whatsapp.builder.preview_note')}{' '}
                    <Link
                        href={waRoutes.pages.settings()}
                        className="underline underline-offset-2"
                    >
                        {t('whatsapp.builder.open_settings')}
                    </Link>
                </p>
            </div>

            <div
                data-testid="builder-whatsapp-checks"
                data-serving={
                    settings.enabled && published && serves ? 'true' : 'false'
                }
                className={cn(
                    'grid gap-2 rounded-lg border p-3',
                    settings.enabled && published && serves
                        ? 'border-emerald-300/70 bg-emerald-50/60 dark:border-emerald-400/30 dark:bg-emerald-400/5'
                        : 'border-amber-300/70 bg-amber-50/60 dark:border-amber-400/30 dark:bg-amber-400/5',
                )}
            >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                    {!(settings.enabled && published && serves) && (
                        <TriangleAlert
                            className="size-4 text-amber-600"
                            aria-hidden
                        />
                    )}
                    {settings.enabled && published && serves
                        ? t('whatsapp.builder.serving')
                        : t('whatsapp.builder.not_serving')}
                </p>
                <ul className="grid gap-1.5">
                    <CheckRow
                        ok={settings.enabled}
                        testId="builder-whatsapp-check-global"
                        label={t('whatsapp.builder.check_global')}
                    />
                    <CheckRow
                        ok={published}
                        testId="builder-whatsapp-check-feature"
                        label={t('whatsapp.builder.check_feature')}
                    />
                    <CheckRow
                        ok={serves}
                        testId="builder-whatsapp-check-session"
                        label={t('whatsapp.builder.check_session')}
                    />
                </ul>
                {draftOn !== published && (
                    <p
                        className="text-xs text-muted-foreground"
                        data-testid="builder-whatsapp-unpublished"
                    >
                        {t('whatsapp.builder.unpublished')}
                    </p>
                )}
            </div>
        </>
    );
}

/**
 * The WhatsApp section of the widget builder (P6, decision P6-D9): switch the channel on for this widget (a draft setting: it reaches
 * visitors on Publish), choose which connected session's number the hand-off offers (live as soon as it is chosen), and see exactly why
 * visitors do, or do not, get the option, with a preview of the message and of the `wa.me` link. Administrators only, like the builder.
 */
export function WhatsAppTab({ state, dispatch }: TabProps) {
    const { t, locale } = useTrans();
    const uid = useId();
    const { features } = state.doc.config;
    const published = state.published.features.whatsapp;
    const loaded = useWhatsAppLink(state.meta.ulid);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const choose = async (value: string): Promise<void> => {
        setSaving(true);
        setError(undefined);

        try {
            const link = await loaded.choose(value === '' ? null : value);

            // The Features tab's "no session is connected" notice reads this.
            dispatch({
                type: 'meta',
                patch: { whatsappConnected: link.connected },
            });
            toast.success(
                t(
                    link.session
                        ? 'whatsapp.builder.linked'
                        : 'whatsapp.builder.unlinked',
                    { name: link.session?.name ?? '' },
                ),
            );
        } catch (failure) {
            setError(
                isApiError(failure) && failure.isValidation
                    ? (failure.firstMessage('session') ??
                          describeWaError(failure, t, locale))
                    : describeWaError(failure, t, locale),
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="grid gap-5" data-testid="builder-panel-whatsapp">
            <SectionCard
                title={t('whatsapp.builder.title')}
                description={t('whatsapp.builder.description')}
            >
                <SwitchRow
                    id={`${uid}-feature`}
                    label={t('whatsapp.builder.feature')}
                    description={t('whatsapp.builder.feature_hint')}
                    checked={features.whatsapp}
                    testId="builder-whatsapp-feature"
                    onCheckedChange={(checked) =>
                        dispatch(
                            sectionAction('features', { whatsapp: checked }),
                        )
                    }
                />
            </SectionCard>

            <SectionCard
                title={t('whatsapp.builder.session_title')}
                description={t('whatsapp.builder.session_description')}
                live
                testId="builder-whatsapp-session-card"
            >
                {loaded.state.status === 'loading' && (
                    <p
                        role="status"
                        data-testid="builder-whatsapp-loading"
                        className="text-sm text-muted-foreground"
                    >
                        {t('whatsapp.builder.loading')}
                    </p>
                )}

                {loaded.state.status === 'error' && (
                    <Notice tone="danger" data-testid="builder-whatsapp-error">
                        <p>{describeWaError(loaded.state.error, t, locale)}</p>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2 bg-background"
                            data-testid="builder-whatsapp-retry"
                            onClick={loaded.reload}
                        >
                            {t('whatsapp.list.retry')}
                        </Button>
                    </Notice>
                )}

                {loaded.state.status === 'ready' && (
                    <ReadyView
                        link={loaded.state.link}
                        sessions={loaded.state.sessions}
                        settings={loaded.state.settings}
                        published={published}
                        draftOn={features.whatsapp}
                        saving={saving}
                        error={error}
                        onChoose={(value) => void choose(value)}
                    />
                )}
            </SectionCard>
        </div>
    );
}
