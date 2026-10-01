import { describe, expect, it } from 'vite-plus/test';
import {
    absoluteTime,
    canSubmitSwitch,
    environmentOf,
    healthTone,
    natsState,
    otherEnvironment,
    relativeTime,
    switchTarget,
} from '@/lib/auth-settings';
import type { PizzasysEnvironmentData } from '@/types/pizzasys';

const env = (
    key: 'production' | 'testing',
    overrides: Partial<PizzasysEnvironmentData> = {},
): PizzasysEnvironmentData => ({
    key,
    label: key,
    configured: true,
    base_url: `https://${key}.example.com`,
    service_name: 'pne-chat',
    has_service_token: true,
    nats_url: null,
    has_nats_token: false,
    verify_tls: true,
    last_check_at: null,
    last_check_status: null,
    last_check_message: null,
    ...overrides,
});

describe('health presentation', () => {
    it('maps each portal status to a tone', () => {
        expect(healthTone('ok')).toBe('ok');
        expect(healthTone('degraded')).toBe('warn');
        expect(healthTone('down')).toBe('bad');
        expect(healthTone('unknown')).toBe('muted');
    });

    it('tells apart disabled, connected, disconnected and silent NATS', () => {
        expect(
            natsState({ enabled: false, connected: null, last_event_at: null }),
        ).toBe('disabled');
        expect(
            natsState({ enabled: false, connected: true, last_event_at: null }),
        ).toBe('disabled');
        expect(
            natsState({ enabled: true, connected: true, last_event_at: null }),
        ).toBe('connected');
        expect(
            natsState({ enabled: true, connected: false, last_event_at: null }),
        ).toBe('disconnected');
        expect(
            natsState({ enabled: true, connected: null, last_event_at: null }),
        ).toBe('unknown');
    });
});

describe('active environment switching', () => {
    it('knows the other environment', () => {
        expect(otherEnvironment('production')).toBe('testing');
        expect(otherEnvironment('testing')).toBe('production');
    });

    it('finds an environment by key', () => {
        const settings = { environments: [env('production'), env('testing')] };

        expect(environmentOf(settings, 'testing')?.key).toBe('testing');
    });

    it('offers a switch only to a configured environment with a stored token', () => {
        const usable = {
            active_env: 'production' as const,
            environments: [env('production'), env('testing')],
        };
        const noToken = {
            ...usable,
            environments: [
                env('production'),
                env('testing', { has_service_token: false }),
            ],
        };
        const unconfigured = {
            ...usable,
            environments: [
                env('production'),
                env('testing', { configured: false }),
            ],
        };

        expect(switchTarget(usable)?.key).toBe('testing');
        expect(switchTarget(noToken)).toBeNull();
        expect(switchTarget(unconfigured)).toBeNull();
        expect(switchTarget({ ...usable, active_env: 'testing' })?.key).toBe(
            'production',
        );
    });

    it('needs both credentials and the acknowledgement to submit a switch', () => {
        const ready = { email: 'a@b.c', password: 'pw', acknowledged: true };

        expect(canSubmitSwitch(ready)).toBe(true);
        expect(canSubmitSwitch({ ...ready, email: '  ' })).toBe(false);
        expect(canSubmitSwitch({ ...ready, password: '' })).toBe(false);
        expect(canSubmitSwitch({ ...ready, acknowledged: false })).toBe(false);
    });
});

describe('time formatting', () => {
    const now = Date.parse('2026-09-30T20:00:00Z');

    it('says how long ago in the viewer locale', () => {
        expect(
            relativeTime('2026-09-30T19:55:00Z', { now, locale: 'en' }),
        ).toBe('5 minutes ago');
        expect(
            relativeTime('2026-09-30T17:00:00Z', { now, locale: 'en' }),
        ).toBe('3 hours ago');
        expect(
            relativeTime('2026-09-28T20:00:00Z', { now, locale: 'en' }),
        ).toBe('2 days ago');
        expect(
            relativeTime('2026-09-30T20:00:10Z', { now, locale: 'en' }),
        ).toBe('now');
    });

    it('has nothing to say for a missing or broken timestamp', () => {
        expect(relativeTime(null, { now })).toBeNull();
        expect(relativeTime('', { now })).toBeNull();
        expect(relativeTime('not a date', { now })).toBeNull();
    });

    it('falls back to English for an unusable locale instead of throwing', () => {
        expect(
            relativeTime('2026-09-30T19:55:00Z', { now, locale: '!!' }),
        ).toBe('5 minutes ago');
    });

    it('formats the exact time, or hands back what it could not parse', () => {
        expect(absoluteTime(null)).toBeNull();
        expect(absoluteTime('garbage')).toBe('garbage');
        expect(absoluteTime('2026-09-30T19:55:00Z', 'en')).toContain('2026');
    });
});
