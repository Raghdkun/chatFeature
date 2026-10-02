/** The sentences of Settings > Notifications that depend on an outcome or a status: one place, so the page stays a plain layout. */
import type { TestOutcome } from '@/lib/notifications/controller';
import type { UnsupportedReason } from '@/lib/notifications/types';

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

const UNSUPPORTED_KEYS: Record<UnsupportedReason, string> = {
    insecure: 'notifications.status.insecure',
    'no-service-worker': 'notifications.status.no_service_worker',
    'no-push': 'notifications.status.no_push',
    'no-notification': 'notifications.status.no_notification',
    'ios-needs-install': 'notifications.status.ios_needs_install',
};

export function unsupportedMessage(
    reason: UnsupportedReason,
    t: Translate,
): string {
    return t(UNSUPPORTED_KEYS[reason]);
}

export type TestMessage = { tone: 'success' | 'danger' | 'info'; text: string };

/** What "Send a test notification" answered, as a sentence and the tone to show it in. */
export function describeTestOutcome(
    outcome: TestOutcome,
    t: Translate,
): TestMessage {
    switch (outcome.kind) {
        case 'sent':
            return {
                tone: 'success',
                text:
                    outcome.sent > 1
                        ? t('notifications.test.sent_many', {
                              count: outcome.sent,
                          })
                        : t('notifications.test.sent_one'),
            };
        case 'none':
            return { tone: 'info', text: t('notifications.test.none') };
        case 'limited':
            return {
                tone: 'danger',
                text:
                    outcome.retryAfter !== null
                        ? t('notifications.test.limited', {
                              seconds: outcome.retryAfter,
                          })
                        : t('notifications.test.limited_generic'),
            };
        case 'unavailable':
            return {
                tone: 'danger',
                text: t('notifications.test.unavailable'),
            };
        default:
            return { tone: 'danger', text: t('notifications.test.failed') };
    }
}
