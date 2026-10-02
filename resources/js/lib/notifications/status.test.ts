import { describe, expect, it } from 'vite-plus/test';
import { browserStatus } from '@/lib/notifications/status';
import { settingsFixture } from '@/tests/notifications-kit';

const base = {
    support: { supported: true } as const,
    pushConfigured: true,
    permission: 'default' as const,
    subscribed: false,
    offHere: false,
    settings: settingsFixture(),
};

describe('browserStatus', () => {
    it('says when the server has no push keys, before anything about the browser', () => {
        expect(browserStatus({ ...base, pushConfigured: false })).toEqual({
            kind: 'unavailable',
        });
        expect(
            browserStatus({
                ...base,
                settings: settingsFixture({ pushAvailable: false }),
            }),
        ).toEqual({ kind: 'unavailable' });
        expect(
            browserStatus({
                ...base,
                pushConfigured: false,
                support: { supported: false, reason: 'insecure' },
            }),
        ).toEqual({ kind: 'unavailable' });
    });

    it('says why the browser cannot do push', () => {
        expect(
            browserStatus({
                ...base,
                support: { supported: false, reason: 'ios-needs-install' },
            }),
        ).toEqual({ kind: 'unsupported', reason: 'ios-needs-install' });
    });

    it('reports a blocked site, an enabled browser and a browser that is off', () => {
        expect(browserStatus({ ...base, permission: 'denied' })).toEqual({
            kind: 'denied',
        });
        expect(
            browserStatus({ ...base, permission: 'granted', subscribed: true }),
        ).toEqual({ kind: 'on' });
        expect(browserStatus(base)).toEqual({ kind: 'off', here: false });
        expect(
            browserStatus({
                ...base,
                permission: 'granted',
                subscribed: true,
                offHere: true,
            }),
        ).toEqual({ kind: 'off', here: true });
        // Granted but not subscribed yet (still working, or it failed): not "on".
        expect(browserStatus({ ...base, permission: 'granted' })).toEqual({
            kind: 'off',
            here: false,
        });
    });

    it('treats unloaded settings as not blocking', () => {
        expect(browserStatus({ ...base, settings: null })).toEqual({
            kind: 'off',
            here: false,
        });
    });
});
