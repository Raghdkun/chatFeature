import { describe, expect, it } from 'vite-plus/test';
import {
    describeTestOutcome,
    unsupportedMessage,
} from '@/lib/notifications/messages';

const t = (key: string, replacements?: Record<string, string | number>) =>
    replacements ? `${key} ${JSON.stringify(replacements)}` : key;

describe('describeTestOutcome', () => {
    it('speaks of one device or many', () => {
        expect(
            describeTestOutcome({ kind: 'sent', sent: 1, devices: 1 }, t),
        ).toEqual({
            tone: 'success',
            text: 'notifications.test.sent_one',
        });
        expect(
            describeTestOutcome({ kind: 'sent', sent: 2, devices: 3 }, t),
        ).toEqual({
            tone: 'success',
            text: 'notifications.test.sent_many {"count":2}',
        });
    });

    it('explains each failure', () => {
        expect(describeTestOutcome({ kind: 'none' }, t).tone).toBe('info');
        expect(describeTestOutcome({ kind: 'failed' }, t).text).toBe(
            'notifications.test.failed',
        );
        expect(describeTestOutcome({ kind: 'unavailable' }, t).text).toBe(
            'notifications.test.unavailable',
        );
        expect(
            describeTestOutcome({ kind: 'limited', retryAfter: 42 }, t).text,
        ).toBe('notifications.test.limited {"seconds":42}');
        expect(
            describeTestOutcome({ kind: 'limited', retryAfter: null }, t).text,
        ).toBe('notifications.test.limited_generic');
    });
});

describe('unsupportedMessage', () => {
    it('has a sentence for every reason', () => {
        for (const reason of [
            'insecure',
            'no-service-worker',
            'no-push',
            'no-notification',
            'ios-needs-install',
        ] as const) {
            expect(unsupportedMessage(reason, t)).toMatch(
                /^notifications\.status\./,
            );
        }
    });
});
