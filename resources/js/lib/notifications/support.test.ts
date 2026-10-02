import { describe, expect, it } from 'vite-plus/test';
import {
    detectPushSupport,
    type SupportEnv,
} from '@/lib/notifications/support';

const env = (overrides: Partial<SupportEnv> = {}): SupportEnv => ({
    isSecureContext: true,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    installed: false,
    maxTouchPoints: 0,
    ...overrides,
});

const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('detectPushSupport', () => {
    it('supports a normal desktop browser', () => {
        expect(detectPushSupport(env())).toEqual({ supported: true });
    });

    it('needs a secure context', () => {
        expect(detectPushSupport(env({ isSecureContext: false }))).toEqual({
            supported: false,
            reason: 'insecure',
        });
    });

    it.each([
        ['hasServiceWorker', 'no-service-worker'],
        ['hasNotification', 'no-notification'],
        ['hasPushManager', 'no-push'],
    ] as const)('names the missing API (%s)', (flag, reason) => {
        expect(detectPushSupport(env({ [flag]: false }))).toEqual({
            supported: false,
            reason,
        });
    });

    it('asks for the Home Screen install on iPhone and iPad (even though PushManager is missing in a Safari tab)', () => {
        expect(
            detectPushSupport(
                env({ userAgent: IPHONE, hasPushManager: false }),
            ),
        ).toEqual({ supported: false, reason: 'ios-needs-install' });
        // iPadOS reports a Mac; the touch screen gives it away.
        expect(
            detectPushSupport(
                env({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 }),
            ),
        ).toEqual({ supported: false, reason: 'ios-needs-install' });
    });

    it('supports an installed iOS web app and a real Mac (no touch screen)', () => {
        expect(
            detectPushSupport(env({ userAgent: IPHONE, installed: true })),
        ).toEqual({ supported: true });
        expect(detectPushSupport(env({ userAgent: IPAD_AS_MAC }))).toEqual({
            supported: true,
        });
    });
});
