/**
 * When the first-login dialog may open (decision P5-D7). Never on page load by itself asking the browser: this only decides whether the
 * in-app explainer is shown; the browser's own prompt appears when the person presses its button, and nowhere else.
 */
import type {
    NotificationSettings,
    PermissionState,
    PushSupport,
} from '@/lib/notifications/types';

export type PromptInput = {
    support: PushSupport;
    /** The server has VAPID keys (the `push` shared prop is not null). */
    pushConfigured: boolean;
    permission: PermissionState;
    /** `null` while the settings are not loaded (or failed to load): unknown is never "ask". */
    settings: Pick<
        NotificationSettings,
        'promptState' | 'snoozedUntil' | 'pushAvailable'
    > | null;
    nowMs: number;
    /** The person turned notifications off for this browser: never nag them. */
    offHere?: boolean;
    /**
     * Only agents are pushed (`PushRecipients`): an account that is not one (an administrator who does not take chats) is never asked,
     * they can still turn notifications on from the settings page. Unspecified = an agent.
     */
    isAgent?: boolean;
};

/**
 * Ask when everything works and the person has not decided: never asked, or a snooze that has run out. A granted or blocked
 * permission, a "no" (`denied`), an active snooze and a browser that cannot do push all stay quiet.
 */
export function shouldPrompt(input: PromptInput): boolean {
    if (
        !input.support.supported ||
        !input.pushConfigured ||
        input.permission !== 'default' ||
        input.offHere === true ||
        input.isAgent === false ||
        input.settings === null ||
        !input.settings.pushAvailable
    ) {
        return false;
    }

    switch (input.settings.promptState) {
        case 'never':
            return true;
        case 'snoozed': {
            const until =
                input.settings.snoozedUntil === null
                    ? Number.NaN
                    : Date.parse(input.settings.snoozedUntil);

            // No (readable) deadline: the snooze has no end to wait for.
            return Number.isNaN(until) || until <= input.nowMs;
        }
        default:
            return false;
    }
}
