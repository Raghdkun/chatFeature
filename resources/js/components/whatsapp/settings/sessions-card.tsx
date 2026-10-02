import { Plus, Smartphone } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { describedBy, Field } from '@/components/setup/field';
import { QrDialog } from '@/components/whatsapp/settings/qr-dialog';
import { ConfirmDialog } from '@/components/whatsapp/settings/confirm-dialog';
import {
    PacingDialog,
    type GlobalPacing,
} from '@/components/whatsapp/settings/pacing-dialog';
import {
    SessionRow,
    type SessionAction,
} from '@/components/whatsapp/settings/session-row';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Busy } from '@/components/widgets/form-bits';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import { isApiError } from '@/lib/api-client';
import type { WaSessionsController } from '@/lib/realtime/whatsapp/use-wa-sessions';
import { classifyWaError, describeWaError } from '@/lib/whatsapp-api/client';
import { WA_LIMITS } from '@/lib/whatsapp-api/types';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

/** `null` when the name is acceptable to OpenWA (3-50 letters, digits, hyphens), else why not. */
export function sessionNameProblem(
    name: string,
): 'length' | 'characters' | null {
    const { min, max, pattern } = WA_LIMITS.sessionName;

    if (name.length < min || name.length > max) {
        return 'length';
    }

    return pattern.test(name) ? null : 'characters';
}

/**
 * The WhatsApp sessions: add one (name rules checked on the spot, the server's answer mapped to the field), start / stop / refresh /
 * delete with the confirmations the destructive ones need, the QR dialog, and live status through `wa.session.status` (or a 15 s poll).
 */
export function SessionsCard({
    controller,
    globalPacing,
}: {
    controller: WaSessionsController;
    /** The global limits (the behaviour settings): what a session without its own limits uses. */
    globalPacing: GlobalPacing;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const uid = useId();
    const { sessions } = controller;
    const [name, setName] = useState('');
    const [nameError, setNameError] = useState<string | undefined>();
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState<{
        ulid: string;
        action: SessionAction;
    } | null>(null);
    const [problems, setProblems] = useState<Record<string, string>>({});
    const [qrFor, setQrFor] = useState<WhatsAppSession | null>(null);
    const [stopping, setStopping] = useState<WhatsAppSession | null>(null);
    const [rewiring, setRewiring] = useState<WhatsAppSession | null>(null);
    const [pacing, setPacing] = useState<WhatsAppSession | null>(null);
    const [deleting, setDeleting] = useState<WhatsAppSession | null>(null);

    const problem = (ulid: string, message: string | null): void =>
        setProblems((held) => {
            const copy = { ...held };

            if (message === null) {
                delete copy[ulid];
            } else {
                copy[ulid] = message;
            }

            return copy;
        });

    const nameMessage = (value: string): string | undefined => {
        const found = sessionNameProblem(value);

        return found === null ? undefined : t(`whatsapp.session.name_${found}`);
    };

    const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        const value = name.trim();
        const invalid = nameMessage(value);

        setNameError(invalid);

        if (invalid || creating) {
            return;
        }

        setCreating(true);

        try {
            const created = await controller.create(value);

            setName('');
            toast.success(
                t('whatsapp.toast.session_created', { name: created.name }),
            );
        } catch (error) {
            setNameError(
                isApiError(error) && error.isValidation
                    ? (error.firstMessage('name') ??
                          describeWaError(error, t, locale))
                    : describeWaError(error, t, locale),
            );
        } finally {
            setCreating(false);
        }
    };

    /** Delete here although OpenWA could not be asked (the OpenWA session may stay behind): only offered after a normal delete failed. */
    const forceDelete = async (): Promise<void> => {
        if (!deleting) {
            return;
        }

        try {
            await controller.remove(deleting.ulid, true);
            toast.success(
                t('whatsapp.toast.session_deleted', { name: deleting.name }),
            );
            setDeleting(null);
        } catch (error) {
            toast.error(describeWaError(error, t, locale));
        }
    };

    const run = async (
        session: WhatsAppSession,
        action: SessionAction,
        call: () => Promise<WhatsAppSession>,
        done?: (next: WhatsAppSession) => void,
    ): Promise<void> => {
        setBusy({ ulid: session.ulid, action });
        problem(session.ulid, null);

        try {
            done?.(await call());
        } catch (error) {
            problem(session.ulid, describeWaError(error, t, locale));
        } finally {
            setBusy(null);
        }
    };

    return (
        <Card
            role="region"
            aria-labelledby="wa-sessions-title"
            data-testid="wa-sessions-card"
        >
            <CardHeader>
                <CardTitle id="wa-sessions-title" role="heading" aria-level={2}>
                    {t('whatsapp.sessions.title')}
                </CardTitle>
                <CardDescription>
                    {t('whatsapp.sessions.description')}
                </CardDescription>
            </CardHeader>

            <CardContent className="grid gap-5">
                <form
                    onSubmit={(event) => void create(event)}
                    noValidate
                    data-testid="wa-session-form"
                    className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                >
                    <Field
                        id={`${uid}-name`}
                        label={t('whatsapp.session.name')}
                        hint={t('whatsapp.session.name_hint')}
                        error={nameError}
                    >
                        <Input
                            id={`${uid}-name`}
                            data-testid="wa-session-name"
                            dir="ltr"
                            value={name}
                            maxLength={WA_LIMITS.sessionName.max}
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="support-main"
                            disabled={creating}
                            aria-invalid={nameError ? true : undefined}
                            aria-describedby={describedBy(`${uid}-name`, {
                                hint: true,
                                error: nameError,
                            })}
                            onChange={(event) => {
                                setName(event.target.value);
                                setNameError(undefined);
                            }}
                        />
                    </Field>
                    <Button
                        type="submit"
                        disabled={creating || name.trim() === ''}
                        data-testid="wa-session-create"
                        className="sm:mb-[1.625rem]"
                    >
                        {creating ? <Busy /> : <Plus aria-hidden />}
                        {t('whatsapp.session.add')}
                    </Button>
                </form>

                {sessions.length === 0 ? (
                    <Empty
                        data-testid="wa-sessions-empty"
                        className="rounded-xl border p-6 md:p-6"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <Smartphone aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle className="text-base">
                                {t('whatsapp.sessions.empty_title')}
                            </EmptyTitle>
                            <EmptyDescription>
                                {t('whatsapp.sessions.empty_body')}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <ul className="grid gap-3" data-testid="wa-sessions-list">
                        {sessions.map((session) => (
                            <SessionRow
                                key={session.ulid}
                                session={session}
                                busy={
                                    busy?.ulid === session.ulid
                                        ? busy.action
                                        : null
                                }
                                error={problems[session.ulid] ?? null}
                                onStart={() =>
                                    void run(
                                        session,
                                        'start',
                                        () => controller.start(session.ulid),
                                        // Started: the scan is the next step, so the code opens at once.
                                        (next) => {
                                            if (next.status !== 'ready') {
                                                setQrFor(next);
                                            }
                                        },
                                    )
                                }
                                onStop={() => setStopping(session)}
                                onSync={() =>
                                    void run(
                                        session,
                                        'sync',
                                        () => controller.sync(session.ulid),
                                        () =>
                                            toast.success(
                                                t(
                                                    'whatsapp.toast.session_synced',
                                                    {
                                                        name: session.name,
                                                    },
                                                ),
                                            ),
                                    )
                                }
                                onWebhook={() => setRewiring(session)}
                                onPacing={() => setPacing(session)}
                                onQr={() => setQrFor(session)}
                                onDelete={() => setDeleting(session)}
                            />
                        ))}
                    </ul>
                )}
            </CardContent>

            <QrDialog
                session={qrFor}
                onClose={() => setQrFor(null)}
                onConnected={(connected) => {
                    setQrFor(null);
                    toast.success(
                        t('whatsapp.toast.session_connected', {
                            name: connected.name,
                        }),
                    );
                }}
                starting={busy?.action === 'start'}
                onStart={(session) =>
                    run(
                        session,
                        'start',
                        () => controller.start(session.ulid),
                        (next) => setQrFor(next),
                    )
                }
            />

            <ConfirmDialog
                open={stopping !== null}
                testId="wa-stop-dialog"
                title={t('whatsapp.stop.title', { name: stopping?.name ?? '' })}
                body={t('whatsapp.stop.body')}
                confirm={t('whatsapp.stop.confirm')}
                cancel={t('whatsapp.cancel')}
                error={(failure) => describeWaError(failure, t, locale)}
                onClose={() => setStopping(null)}
                onConfirm={async () => {
                    if (stopping) {
                        await controller.stop(stopping.ulid);
                        toast.success(
                            t('whatsapp.toast.session_stopped', {
                                name: stopping.name,
                            }),
                        );
                        setStopping(null);
                    }
                }}
            />

            <PacingDialog
                session={pacing}
                global={globalPacing}
                onClose={() => setPacing(null)}
                onSave={(ulid, input) => controller.updatePacing(ulid, input)}
            />

            <ConfirmDialog
                open={rewiring !== null}
                testId="wa-webhook-dialog"
                title={t('whatsapp.webhook.title', {
                    name: rewiring?.name ?? '',
                })}
                body={t('whatsapp.webhook.body')}
                confirm={t('whatsapp.webhook.confirm')}
                cancel={t('whatsapp.cancel')}
                error={(failure) => describeWaError(failure, t, locale)}
                onClose={() => setRewiring(null)}
                onConfirm={async () => {
                    if (rewiring) {
                        await controller.reregisterWebhook(rewiring.ulid);
                        toast.success(
                            t('whatsapp.toast.webhook_reregistered', {
                                name: rewiring.name,
                            }),
                        );
                        setRewiring(null);
                    }
                }}
            />

            <ConfirmDialog
                open={deleting !== null}
                testId="wa-delete-dialog"
                destructive
                title={t('whatsapp.delete.title', {
                    name: deleting?.name ?? '',
                })}
                body={
                    <>
                        {t('whatsapp.delete.body')}
                        {deleting && deleting.linkedWidgetsCount > 0 && (
                            <>
                                {' '}
                                <strong data-testid="wa-delete-widgets">
                                    {plural(
                                        'whatsapp.delete.widgets',
                                        deleting.linkedWidgetsCount,
                                    )}
                                </strong>
                            </>
                        )}
                    </>
                }
                confirm={t('whatsapp.delete.confirm')}
                cancel={t('whatsapp.cancel')}
                error={(failure) => describeWaError(failure, t, locale)}
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    if (deleting) {
                        await controller.remove(deleting.ulid);
                        toast.success(
                            t('whatsapp.toast.session_deleted', {
                                name: deleting.name,
                            }),
                        );
                        setDeleting(null);
                    }
                }}
                extra={(failure) =>
                    isApiError(failure) &&
                    failure.code === 'openwa_unavailable' &&
                    classifyWaError(failure) === 'unreachable' ? (
                        <div
                            className="grid gap-2 rounded-lg border border-dashed p-3 text-sm"
                            data-testid="wa-delete-force"
                        >
                            <p>{t('whatsapp.delete.force_hint')}</p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-fit"
                                data-testid="wa-delete-force-confirm"
                                onClick={() => void forceDelete()}
                            >
                                {t('whatsapp.delete.force')}
                            </Button>
                        </div>
                    ) : null
                }
            />
        </Card>
    );
}
