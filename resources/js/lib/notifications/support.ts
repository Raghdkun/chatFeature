/**
 * Feature detection for web push (decision P5-D7): which of the three browser APIs exist, whether the page is a secure context, and
 * the iOS rule (Safari on iPhone / iPad only delivers push to an app added to the Home Screen). A browser that fails any check falls
 * back to the in-tab alerts the dashboard always had: toast, sound and the title badge.
 */
import type { PermissionState, PushSupport } from '@/lib/notifications/types';

/** The slice of `window` / `navigator` the detection reads; tests pass their own. */
export type SupportEnv = {
    isSecureContext: boolean;
    hasServiceWorker: boolean;
    hasPushManager: boolean;
    hasNotification: boolean;
    userAgent: string;
    /** `navigator.standalone` (iOS) or the `display-mode: standalone` media query. */
    installed: boolean;
    maxTouchPoints: number;
};

export function browserSupportEnv(): SupportEnv {
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    const standalone =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches;

    return {
        isSecureContext:
            typeof window !== 'undefined' && window.isSecureContext === true,
        hasServiceWorker: !!nav && 'serviceWorker' in nav,
        hasPushManager:
            typeof window !== 'undefined' && 'PushManager' in window,
        hasNotification:
            typeof window !== 'undefined' && 'Notification' in window,
        userAgent: nav?.userAgent ?? '',
        installed:
            standalone ||
            (!!nav &&
                (nav as Navigator & { standalone?: boolean }).standalone ===
                    true),
        maxTouchPoints: nav?.maxTouchPoints ?? 0,
    };
}

/** iPhone, iPod, iPad (and iPadOS, which calls itself a Mac but has a touch screen). */
function isIos(env: SupportEnv): boolean {
    return (
        /iPhone|iPad|iPod/.test(env.userAgent) ||
        (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)
    );
}

export function detectPushSupport(
    env: SupportEnv = browserSupportEnv(),
): PushSupport {
    if (!env.isSecureContext) {
        return { supported: false, reason: 'insecure' };
    }

    // Before the APIs: on iOS the missing `PushManager` of a plain Safari tab is "install the app first", not "old browser".
    if (isIos(env) && !env.installed) {
        return { supported: false, reason: 'ios-needs-install' };
    }

    if (!env.hasServiceWorker) {
        return { supported: false, reason: 'no-service-worker' };
    }

    if (!env.hasNotification) {
        return { supported: false, reason: 'no-notification' };
    }

    if (!env.hasPushManager) {
        return { supported: false, reason: 'no-push' };
    }

    return { supported: true };
}

export function readPermission(): PermissionState {
    return typeof Notification === 'undefined'
        ? 'unsupported'
        : Notification.permission;
}
