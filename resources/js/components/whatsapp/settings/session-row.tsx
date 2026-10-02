import {
    CircleAlert,
    Play,
    QrCode,
    RefreshCw,
    Square,
    Trash2,
    Webhook,
} from 'lucide-react';
import { fullDateTime } from '@/components/inbox/format';
import { PhoneNumber } from '@/components/whatsapp/phone-number';
import { SessionStatusBadge } from '@/components/whatsapp/session-status';
import { Button } from '@/components/ui/button';
import { Busy, Notice } from '@/components/widgets/form-bits';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

export type SessionAction = 'start' | 'stop' | 'sync' | 'webhook' | 'delete';

/** What a person can try for a failed session, from what the last error says (never a guess dressed up as a diagnosis: the log is named too). */
export function troubleshootingKey(session: WhatsAppSession): string | null {
    if (session.status !== 'failed' && session.lastError === null) {
        return session.webhookRegistered ||
            session.status === 'created' ||
            session.status === 'disconnected'
            ? null
            : 'whatsapp.hint.webhook_missing';
    }

    const error = (session.lastError ?? '').toLowerCase();

    if (/webhook|ssrf|private address|allowed_hosts/.test(error)) {
        return 'whatsapp.hint.webhook';
    }

    if (
        /unreachable|econnrefused|timed out|timeout|could not be reached|enotfound/.test(
            error,
        )
    ) {
        return 'whatsapp.hint.unreachable';
    }

    if (/unauthori|api key|forbidden|401|403/.test(error)) {
        return 'whatsapp.hint.key';
    }

    return 'whatsapp.hint.generic';
}

/** One session: its state, the number (masked until revealed), what it is wired to, and what an administrator can do with it right now. */
export function SessionRow({
    session,
    busy,
    error,
    onStart,
    onStop,
    onSync,
    onWebhook,
    onPacing,
    onQr,
    onDelete,
}: {
    session: WhatsAppSession;
    /** The action in flight for this session. */
    busy: SessionAction | null;
    /** The last failure of an action, in words. */
    error: string | null;
    onStart: () => void;
    onStop: () => void;
    onSync: () => void;
    /** Register the webhook again (a new secret): asked to be confirmed by the card. */
    onWebhook: () => void;
    /** Edit this session's own sending limits. */
    onPacing: () => void;
    onQr: () => void;
    onDelete: () => void;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const canStart =
        session.status === 'created' ||
        session.status === 'disconnected' ||
        session.status === 'failed';
    const running =
        session.status === 'starting' ||
        session.status === 'qr' ||
        session.status === 'ready';
    const hint = troubleshootingKey(session);
    const disabled = busy !== null;

    return (
        <li
            data-testid={`wa-session-${session.ulid}`}
            data-status={session.status}
            className="grid gap-3 rounded-xl border bg-card p-4"
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h3
                    className="min-w-0 text-sm font-semibold break-all"
                    dir="ltr"
                    data-testid={`wa-session-name-${session.ulid}`}
                >
                    {session.name}
                </h3>
                <SessionStatusBadge
                    status={session.status}
                    testId={`wa-session-status-${session.ulid}`}
                />
                <span className="text-xs text-muted-foreground">
                    {session.engine}
                </span>
            </div>

            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">
                        {t('whatsapp.session.number')}
                    </dt>
                    <dd>
                        <PhoneNumber
                            phone={session.phone}
                            masked={session.maskedPhone}
                            testId={`wa-session-phone-${session.ulid}`}
                        />
                        {session.pushName && (
                            <span
                                dir="auto"
                                className="ms-2 text-muted-foreground"
                            >
                                {session.pushName}
                            </span>
                        )}
                    </dd>
                </div>
                <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">
                        {t('whatsapp.session.linked_since')}
                    </dt>
                    <dd>
                        {session.readyAt
                            ? fullDateTime(session.readyAt, locale)
                            : t('whatsapp.session.never')}
                    </dd>
                </div>
                <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">
                        {t('whatsapp.session.webhook')}
                    </dt>
                    <dd className="flex flex-wrap items-center gap-x-1.5">
                        <Webhook
                            className="size-3.5 text-muted-foreground"
                            aria-hidden
                        />
                        <span
                            data-testid={`wa-session-webhook-${session.ulid}`}
                        >
                            {session.webhookRegistered
                                ? t('whatsapp.session.webhook_ok')
                                : t('whatsapp.session.webhook_missing')}
                        </span>
                        {session.webhookUrl && (
                            <code
                                dir="ltr"
                                data-testid={`wa-session-webhook-url-${session.ulid}`}
                                className="block w-full text-xs [overflow-wrap:anywhere] text-muted-foreground"
                            >
                                {session.webhookUrl}
                            </code>
                        )}
                    </dd>
                </div>
                <div className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">
                        {t('whatsapp.session.widgets')}
                    </dt>
                    <dd>
                        {session.linkedWidgetsCount > 0
                            ? plural(
                                  'whatsapp.session.widgets_count',
                                  session.linkedWidgetsCount,
                              )
                            : t('whatsapp.session.no_widgets')}
                    </dd>
                </div>
                <div className="grid gap-0.5 sm:col-span-2">
                    <dt className="text-xs text-muted-foreground">
                        {t('whatsapp.session.limits')}
                    </dt>
                    <dd data-testid={`wa-session-limits-${session.ulid}`}>
                        {t('whatsapp.session.limits_value', {
                            interval: (
                                session.sendMinIntervalMs / 1000
                            ).toLocaleString(locale),
                            cap: session.dailySendCap.toLocaleString(locale),
                        })}
                        {session.pacingOverridden &&
                            ` · ${t('whatsapp.session.limits_own')}`}{' '}
                        <button
                            type="button"
                            disabled={disabled}
                            data-testid={`wa-session-pacing-${session.ulid}`}
                            onClick={onPacing}
                            className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                        >
                            {t('whatsapp.session.limits_edit')}
                        </button>
                    </dd>
                </div>
            </dl>

            {session.lastError && (
                <p
                    role="alert"
                    data-testid={`wa-session-error-${session.ulid}`}
                    className="flex items-start gap-2 rounded-lg border border-red-300/70 bg-red-50 px-3 py-2 text-sm [overflow-wrap:anywhere] text-red-950 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-100"
                >
                    <CircleAlert
                        className="mt-0.5 size-4 shrink-0"
                        aria-hidden
                    />
                    <span>
                        <span className="font-medium">
                            {t('whatsapp.session.last_error')}
                        </span>{' '}
                        {session.lastError}
                    </span>
                </p>
            )}
            {hint && (
                <Notice
                    tone="info"
                    data-testid={`wa-session-hint-${session.ulid}`}
                    className="text-xs"
                >
                    {t(hint)}
                </Notice>
            )}
            {error && (
                <Notice
                    tone="danger"
                    data-testid={`wa-session-problem-${session.ulid}`}
                    className="text-xs"
                >
                    {error}
                </Notice>
            )}

            <div className="flex flex-wrap items-center gap-2">
                {canStart && (
                    <Button
                        type="button"
                        size="sm"
                        disabled={disabled}
                        data-testid={`wa-session-start-${session.ulid}`}
                        onClick={onStart}
                    >
                        {busy === 'start' ? <Busy /> : <Play aria-hidden />}
                        {t('whatsapp.session.start')}
                    </Button>
                )}
                {(session.status === 'qr' || session.status === 'starting') && (
                    <Button
                        type="button"
                        size="sm"
                        variant={
                            session.status === 'qr' ? 'default' : 'outline'
                        }
                        disabled={disabled}
                        data-testid={`wa-session-qr-${session.ulid}`}
                        onClick={onQr}
                    >
                        <QrCode aria-hidden />
                        {t('whatsapp.session.scan')}
                    </Button>
                )}
                {running && (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        data-testid={`wa-session-stop-${session.ulid}`}
                        onClick={onStop}
                    >
                        {busy === 'stop' ? <Busy /> : <Square aria-hidden />}
                        {t('whatsapp.session.stop')}
                    </Button>
                )}
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    data-testid={`wa-session-sync-${session.ulid}`}
                    onClick={onSync}
                >
                    {busy === 'sync' ? <Busy /> : <RefreshCw aria-hidden />}
                    {t('whatsapp.session.sync')}
                </Button>
                {session.status !== 'created' && (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        data-testid={`wa-session-webhook-reregister-${session.ulid}`}
                        onClick={onWebhook}
                    >
                        {busy === 'webhook' ? (
                            <Busy />
                        ) : (
                            <Webhook aria-hidden />
                        )}
                        {t('whatsapp.session.webhook_reregister')}
                    </Button>
                )}
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    className="ms-auto text-destructive-foreground hover:text-destructive-foreground"
                    data-testid={`wa-session-delete-${session.ulid}`}
                    onClick={onDelete}
                >
                    <Trash2 aria-hidden />
                    {t('whatsapp.session.delete')}
                </Button>
            </div>
        </li>
    );
}
