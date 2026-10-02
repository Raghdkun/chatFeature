/**
 * The first-login explainer (decision P5-D7): an in-app dialog that says what notifications are for BEFORE the browser's own
 * permission prompt appears. Only its primary button calls `Notification.requestPermission()` (through the controller's `enable()`);
 * "Not now", Escape and the close button all snooze it (7 days, computed by the server), so it never nags.
 */
import { Bell, MessageSquareText, Siren } from 'lucide-react';
import { toast } from 'sonner';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Busy } from '@/components/widgets/form-bits';
import { useNotificationsState } from '@/lib/notifications/context';
import type {
    EnableResult,
    NotificationsController,
} from '@/lib/notifications/controller';

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

/** The toast that answers what the person chose; `dismissed` (the browser's prompt closed without an answer) says nothing. */
export function announceEnableResult(
    result: EnableResult,
    t: Translate,
    show: Pick<typeof toast, 'success' | 'error' | 'info'> = toast,
): void {
    if (result === 'enabled') {
        show.success(t('notifications.prompt.enabled'));
    } else if (result === 'denied') {
        show.info(t('notifications.prompt.denied'), { duration: 12_000 });
    } else if (result === 'failed') {
        show.error(t('notifications.prompt.failed'));
    }
}

export function NotificationPrompt({
    controller,
    t,
    suppressed = false,
}: {
    controller: NotificationsController;
    t: Translate;
    /** Do not show it right now (the settings page has the same controls). */
    suppressed?: boolean;
}) {
    const state = useNotificationsState(controller);
    const open = (state?.promptOpen ?? false) && !suppressed;
    const asking = state?.busy === 'enable';
    const returnFocus = useReturnFocus(open);

    const enable = async (): Promise<void> => {
        announceEnableResult(await controller.enable(), t);
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                // Not while the browser's own prompt is up: closing now would snooze an answer that is still coming.
                if (!next && !asking) {
                    void controller.snooze();
                }
            }}
        >
            <DialogContent data-testid="notification-prompt" {...returnFocus}>
                <DialogHeader>
                    <div
                        className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"
                        aria-hidden
                    >
                        <Bell className="size-5" />
                    </div>
                    <DialogTitle>{t('notifications.prompt.title')}</DialogTitle>
                    <DialogDescription>
                        {t('notifications.prompt.description')}
                    </DialogDescription>
                </DialogHeader>

                <ul className="grid gap-2 text-sm">
                    <li className="flex items-start gap-2.5">
                        <Siren
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                        />
                        <span>{t('notifications.prompt.benefit_offers')}</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                        <MessageSquareText
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                        />
                        <span>
                            {t('notifications.prompt.benefit_messages')}
                        </span>
                    </li>
                </ul>

                <p className="text-sm text-muted-foreground">
                    {t('notifications.prompt.note', {
                        days: state?.settings?.snoozeDays ?? 7,
                    })}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={asking}
                        data-testid="notification-prompt-later"
                        onClick={() => void controller.snooze()}
                    >
                        {t('notifications.prompt.later')}
                    </Button>
                    <Button
                        type="button"
                        disabled={asking}
                        data-testid="notification-prompt-enable"
                        onClick={() => void enable()}
                    >
                        {asking && <Busy />}
                        {asking
                            ? t('notifications.prompt.enabling')
                            : t('notifications.prompt.enable')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
