import { useState } from 'react';
import { toast } from 'sonner';
import { announceEnableResult } from '@/components/notifications/notification-prompt';
import { Button } from '@/components/ui/button';
import { Busy, Notice, SectionCard } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import type {
    NotificationsController,
    NotificationsState,
} from '@/lib/notifications/controller';
import {
    describeTestOutcome,
    unsupportedMessage,
    type TestMessage,
} from '@/lib/notifications/messages';
import { browserStatus } from '@/lib/notifications/status';

/**
 * "This browser": whether push works here and the buttons that change it (turn on, turn off, send a test). The permission help for a
 * blocked site and the explanation for a browser that cannot do push live here too (decision P5-D7); without push the dashboard
 * still alerts with a toast, a sound and the title badge.
 */
export function BrowserSection({
    controller,
    state,
}: {
    controller: NotificationsController;
    state: NotificationsState;
}) {
    const { t } = useTrans();
    const [test, setTest] = useState<TestMessage | null>(null);
    const status = browserStatus(state);
    const busy = state.busy;

    const enable = async (): Promise<void> => {
        setTest(null);
        announceEnableResult(await controller.enable(), t);
    };

    const sendTest = async (): Promise<void> => {
        setTest(null);
        setTest(describeTestOutcome(await controller.sendTest(), t));
    };

    return (
        <SectionCard
            title={t('notifications.browser.title')}
            description={t('notifications.browser.description')}
            testId="notifications-browser"
        >
            <div className="grid gap-3" data-status={status.kind}>
                {status.kind === 'on' && (
                    <Notice tone="success" data-testid="notifications-status">
                        {t('notifications.status.on')}
                    </Notice>
                )}

                {status.kind === 'off' && (
                    <Notice data-testid="notifications-status">
                        {status.here
                            ? t('notifications.status.off_here')
                            : t('notifications.status.off')}
                    </Notice>
                )}

                {status.kind === 'denied' && (
                    <Notice tone="warning" data-testid="notifications-status">
                        <p className="font-medium">
                            {t('notifications.status.denied')}
                        </p>
                        <p className="mt-1">
                            {t('notifications.status.denied_help')}
                        </p>
                    </Notice>
                )}

                {status.kind === 'unsupported' && (
                    <Notice tone="warning" data-testid="notifications-status">
                        <p>{unsupportedMessage(status.reason, t)}</p>
                        <p className="mt-1 text-muted-foreground">
                            {t('notifications.status.fallback')}
                        </p>
                    </Notice>
                )}

                {status.kind === 'unavailable' && (
                    <Notice tone="warning" data-testid="notifications-status">
                        <p>{t('notifications.status.unavailable')}</p>
                        <p className="mt-1 text-muted-foreground">
                            {t('notifications.status.fallback')}
                        </p>
                    </Notice>
                )}

                <div className="flex flex-wrap gap-2">
                    {status.kind === 'off' && (
                        <Button
                            type="button"
                            disabled={busy !== null}
                            data-testid="notifications-enable"
                            onClick={() => void enable()}
                        >
                            {busy === 'enable' && <Busy />}
                            {busy === 'enable'
                                ? t('notifications.action.enabling')
                                : t('notifications.action.enable')}
                        </Button>
                    )}

                    {status.kind === 'on' && (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy !== null}
                                data-testid="notifications-test"
                                onClick={() => void sendTest()}
                            >
                                {busy === 'test' && <Busy />}
                                {busy === 'test'
                                    ? t('notifications.action.testing')
                                    : t('notifications.action.test')}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={busy !== null}
                                data-testid="notifications-disable"
                                onClick={() => {
                                    setTest(null);
                                    void controller
                                        .disable()
                                        .catch(() =>
                                            toast.error(
                                                t(
                                                    'notifications.settings.save_failed',
                                                ),
                                            ),
                                        );
                                }}
                            >
                                {busy === 'disable' && <Busy />}
                                {t('notifications.action.disable')}
                            </Button>
                        </>
                    )}
                </div>

                {/* A polite live region: a screen reader hears the answer to "Send a test notification". */}
                <div
                    role="status"
                    aria-live="polite"
                    data-testid="notifications-test-result"
                >
                    {test && <Notice tone={test.tone}>{test.text}</Notice>}
                </div>
            </div>
        </SectionCard>
    );
}
