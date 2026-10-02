/**
 * What the "This browser" section of Settings > Notifications says, as one decision (so the page is a plain switch over it and the logic
 * is tested without rendering). Order matters: a server without push keys beats everything, then a browser that cannot do push, then
 * the browser's own permission, then whether this browser is actually subscribed.
 */
import type { NotificationsState } from '@/lib/notifications/controller';
import type { UnsupportedReason } from '@/lib/notifications/types';

export type BrowserStatus =
    | { kind: 'unavailable' }
    | { kind: 'unsupported'; reason: UnsupportedReason }
    | { kind: 'denied' }
    | { kind: 'on' }
    /** `here`: the person turned it off for this browser (rather than never turning it on). */
    | { kind: 'off'; here: boolean };

export function browserStatus(
    state: Pick<
        NotificationsState,
        | 'support'
        | 'pushConfigured'
        | 'permission'
        | 'subscribed'
        | 'offHere'
        | 'settings'
    >,
): BrowserStatus {
    if (
        !state.pushConfigured ||
        (state.settings !== null && !state.settings.pushAvailable)
    ) {
        return { kind: 'unavailable' };
    }

    if (!state.support.supported) {
        return { kind: 'unsupported', reason: state.support.reason };
    }

    if (state.permission === 'denied') {
        return { kind: 'denied' };
    }

    if (state.permission === 'granted' && state.subscribed && !state.offHere) {
        return { kind: 'on' };
    }

    return { kind: 'off', here: state.offHere };
}
