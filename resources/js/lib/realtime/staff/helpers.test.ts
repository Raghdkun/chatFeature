import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { newClientMsgId } from '@/lib/realtime/staff/client-id';
import { withAttentionCount } from '@/lib/realtime/staff/document-title';
import {
    reverbSettings,
    socketsConfigured,
    staffChannelAuthorization,
    staffEchoOptions,
} from '@/lib/realtime/staff/echo-config';
import {
    closeOsNotification,
    showOsNotification,
    type OsNotificationEnv,
} from '@/lib/realtime/staff/os-notification';
import { bindSoundUnlock, createSoundPlayer } from '@/lib/realtime/staff/sound';

describe('newClientMsgId', () => {
    it('is a 26-character Crockford-base32 ULID', () => {
        expect(newClientMsgId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('encodes the time in the first ten characters so ids sort by creation', () => {
        const zero = () => new Uint8Array(16);

        expect(newClientMsgId(0, zero)).toBe('0'.repeat(26));
        expect(newClientMsgId(1, zero).slice(0, 10)).toBe('0000000001');
        expect(newClientMsgId(32, zero).slice(0, 10)).toBe('0000000010');
        expect(newClientMsgId(1000, zero) < newClientMsgId(2000, zero)).toBe(
            true,
        );
    });

    it('is random enough that two ids in the same millisecond differ', () => {
        expect(newClientMsgId(5)).not.toBe(newClientMsgId(5));
    });
});

describe('withAttentionCount', () => {
    it('prefixes the count, replaces an old prefix and never stacks', () => {
        expect(withAttentionCount('Inbox - App', 3)).toBe('(3) Inbox - App');
        expect(withAttentionCount('(3) Inbox - App', 5)).toBe(
            '(5) Inbox - App',
        );
        expect(withAttentionCount('(3) Inbox - App', 0)).toBe('Inbox - App');
        expect(withAttentionCount('Inbox - App', 0)).toBe('Inbox - App');
        expect(withAttentionCount('Inbox', 250)).toBe('(99+) Inbox');
    });
});

describe('channel authorization', () => {
    it('reads the XSRF cookie at request time, not at configuration time', () => {
        let token: string | null = 'first';
        const auth = staffChannelAuthorization(() => token);

        expect(auth.endpoint).toBe('/broadcasting/auth');
        expect(auth.transport).toBe('ajax');
        expect(auth.headersProvider()).toMatchObject({
            'X-XSRF-TOKEN': 'first',
            Accept: 'application/json',
        });

        token = 'rotated';
        expect(auth.headersProvider()['X-XSRF-TOKEN']).toBe('rotated');

        token = null;
        expect(auth.headersProvider()).not.toHaveProperty('X-XSRF-TOKEN');
    });

    it('uses the websocket only when the build has the Reverb key', () => {
        expect(socketsConfigured({ VITE_REVERB_APP_KEY: 'abc' })).toBe(true);
        expect(socketsConfigured({ VITE_REVERB_APP_KEY: '' })).toBe(false);
        expect(socketsConfigured({})).toBe(false);
    });
});

describe('where the websocket connects', () => {
    const prop = {
        key: 'runtime-key',
        host: 'ws.chat.example',
        port: 8443,
        scheme: 'https',
    };

    it("prefers the shared prop (the server's own settings, no rebuild) over the build-time VITE values", () => {
        expect(
            reverbSettings(prop, {
                VITE_REVERB_APP_KEY: 'build-key',
                VITE_REVERB_HOST: 'build.example',
                VITE_REVERB_PORT: '80',
                VITE_REVERB_SCHEME: 'http',
            }),
        ).toEqual({
            key: 'runtime-key',
            host: 'ws.chat.example',
            port: 8443,
            forceTLS: true,
        });
        expect(reverbSettings({ ...prop, scheme: 'http' }, {})?.forceTLS).toBe(
            false,
        );
    });

    it('falls back to the VITE values when the prop is absent or unusable', () => {
        const env = {
            VITE_REVERB_APP_KEY: 'build-key',
            VITE_REVERB_HOST: 'build.example',
            VITE_REVERB_PORT: '8080',
            VITE_REVERB_SCHEME: 'http',
        };

        for (const unusable of [
            null,
            undefined,
            { ...prop, key: '' },
            { ...prop, host: ' ' },
            { ...prop, port: 0 },
        ]) {
            expect(reverbSettings(unusable, env)).toEqual({
                key: 'build-key',
                host: 'build.example',
                port: 8080,
                forceTLS: false,
            });
        }
    });

    it('is nowhere when neither source has an address, and socketsConfigured says exactly that', () => {
        expect(reverbSettings(null, {})).toBeNull();
        expect(reverbSettings(null, { VITE_REVERB_APP_KEY: '' })).toBeNull();
        expect(socketsConfigured({}, null)).toBe(false);
        // the prop alone is enough (an installation built without VITE_REVERB_*)
        expect(socketsConfigured({}, prop)).toBe(true);
        expect(socketsConfigured({ VITE_REVERB_APP_KEY: 'abc' }, null)).toBe(
            true,
        );
    });

    it('turns either source into the Echo options, with the channel authorisation, and logs nothing', () => {
        const log = vi
            .spyOn(console, 'log')
            .mockImplementation(() => undefined);
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);

        try {
            expect(staffEchoOptions(prop, {})).toMatchObject({
                broadcaster: 'reverb',
                key: 'runtime-key',
                wsHost: 'ws.chat.example',
                wsPort: 8443,
                wssPort: 8443,
                forceTLS: true,
                enabledTransports: ['ws', 'wss'],
                channelAuthorization: { endpoint: '/broadcasting/auth' },
            });
            expect(
                staffEchoOptions(null, {
                    VITE_REVERB_APP_KEY: 'build-key',
                    VITE_REVERB_HOST: 'build.example',
                    VITE_REVERB_PORT: '443',
                    VITE_REVERB_SCHEME: 'https',
                }),
            ).toMatchObject({
                key: 'build-key',
                wsHost: 'build.example',
                wsPort: 443,
            });

            // nothing known: only the authorisation (the library's own defaults apply, and no socket is opened)
            const none = staffEchoOptions(null, {});

            expect(none).not.toHaveProperty('key');
            expect(none).toHaveProperty('channelAuthorization');
            expect(log).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
            warn.mockRestore();
        }
    });
});

describe('showOsNotification', () => {
    class FakeNotification {
        static permission: NotificationPermission = 'granted';
        static instances: FakeNotification[] = [];
        onclick: ((event: Event) => void) | null = null;
        closed = false;

        constructor(
            public title: string,
            public options?: { body?: string; tag?: string },
        ) {
            FakeNotification.instances.push(this);
        }

        close() {
            this.closed = true;
        }
    }

    const env = (
        overrides: Partial<OsNotificationEnv> = {},
    ): OsNotificationEnv => ({
        Notification: FakeNotification,
        pageInFront: () => false,
        focusWindow: vi.fn(),
        ...overrides,
    });

    beforeEach(() => {
        FakeNotification.permission = 'granted';
        FakeNotification.instances = [];
    });

    it('shows a notification only when permission is already granted and the page is in the background', () => {
        expect(
            showOsNotification({ title: 'New chat', tag: 't1' }, env()),
        ).toBe(true);
        expect(FakeNotification.instances).toHaveLength(1);

        expect(
            showOsNotification(
                { title: 'x', tag: 't2' },
                env({ pageInFront: () => true }),
            ),
        ).toBe(false);

        FakeNotification.permission = 'default';
        expect(showOsNotification({ title: 'x', tag: 't3' }, env())).toBe(
            false,
        );
        FakeNotification.permission = 'denied';
        expect(showOsNotification({ title: 'x', tag: 't4' }, env())).toBe(
            false,
        );
        expect(
            showOsNotification(
                { title: 'x', tag: 't5' },
                env({ Notification: undefined }),
            ),
        ).toBe(false);
        expect(FakeNotification.instances).toHaveLength(1);
    });

    it('never asks for permission', () => {
        const request = vi.fn();

        (
            FakeNotification as unknown as { requestPermission: () => void }
        ).requestPermission = request;
        showOsNotification({ title: 'x', tag: 't6' }, env());

        expect(request).not.toHaveBeenCalled();
    });

    it('focuses the window and runs the click handler, then closes', () => {
        const focusWindow = vi.fn();
        const onClick = vi.fn();

        showOsNotification(
            { title: 'x', tag: 't7', onClick },
            env({ focusWindow }),
        );
        const shown = FakeNotification.instances[0];

        shown.onclick?.(new Event('click'));

        expect(focusWindow).toHaveBeenCalled();
        expect(onClick).toHaveBeenCalled();
        expect(shown.closed).toBe(true);
    });

    it('replaces the notification with the same tag and closes it on request', () => {
        showOsNotification({ title: 'a', tag: 'same' }, env());
        showOsNotification({ title: 'b', tag: 'same' }, env());

        expect(FakeNotification.instances[0].closed).toBe(true);

        closeOsNotification('same');
        expect(FakeNotification.instances[1].closed).toBe(true);
    });

    it('swallows a constructor that throws (some mobile browsers)', () => {
        class Throwing {
            static permission: NotificationPermission = 'granted';
            constructor() {
                throw new Error('Illegal constructor');
            }
        }

        expect(
            showOsNotification(
                { title: 'x', tag: 't8' },
                {
                    Notification:
                        Throwing as unknown as OsNotificationEnv['Notification'],
                    pageInFront: () => false,
                    focusWindow: () => undefined,
                },
            ),
        ).toBe(false);
    });
});

describe('createSoundPlayer', () => {
    function fakeContext(state: 'suspended' | 'running' = 'suspended') {
        const oscillators: {
            frequency: { value: number };
            start: ReturnType<typeof vi.fn>;
        }[] = [];
        const context = {
            state,
            currentTime: 10,
            destination: {},
            resume: vi.fn(async () => {
                context.state = 'running';
            }),
            createGain: () => ({
                gain: {
                    setValueAtTime: vi.fn(),
                    linearRampToValueAtTime: vi.fn(),
                    exponentialRampToValueAtTime: vi.fn(),
                },
                connect: (next: unknown) => next,
            }),
            createOscillator: () => {
                const oscillator = {
                    type: 'sine',
                    frequency: { value: 0 },
                    connect: (next: unknown) => next,
                    start: vi.fn(),
                    stop: vi.fn(),
                };

                oscillators.push(oscillator);

                return oscillator;
            },
        };

        return { context, oscillators };
    }

    const memory = () => {
        const data = new Map<string, string>();

        return {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => void data.set(key, value),
        };
    };

    it('is silent until the first gesture unlocks the audio context', async () => {
        const { context, oscillators } = fakeContext();
        const player = createSoundPlayer(
            () => context as unknown as AudioContext,
            memory(),
        );

        player.play('offer');
        expect(oscillators).toHaveLength(0);

        player.unlock();
        await Promise.resolve();
        player.play('offer');

        expect(context.resume).toHaveBeenCalled();
        expect(oscillators.map((o) => o.frequency.value)).toEqual([
            659.25, 783.99, 1046.5,
        ]);
    });

    it('plays a single tick for a message and nothing while muted (remembered)', () => {
        const { context, oscillators } = fakeContext('running');
        const storage = memory();
        const player = createSoundPlayer(
            () => context as unknown as AudioContext,
            storage,
        );

        player.unlock();
        player.play('message');
        expect(oscillators).toHaveLength(1);

        const listener = vi.fn();

        player.subscribe(listener);
        player.setMuted(true);
        player.play('offer');

        expect(oscillators).toHaveLength(1);
        expect(listener).toHaveBeenCalled();
        expect(createSoundPlayer(() => null, storage).isMuted()).toBe(true);
    });

    it('reports locked until a gesture lets the page make sound, then on; muted wins over both', async () => {
        const { context } = fakeContext();
        const player = createSoundPlayer(
            () => context as unknown as AudioContext,
            memory(),
        );
        const listener = vi.fn();

        player.subscribe(listener);
        expect(player.state()).toBe('locked');

        player.unlock();
        await Promise.resolve();
        await Promise.resolve();

        expect(player.state()).toBe('on');
        expect(listener).toHaveBeenCalled();

        player.setMuted(true);
        expect(player.state()).toBe('muted');
        player.setMuted(false);
        expect(player.state()).toBe('on');
    });

    it('does not call a browser without Web Audio "locked" once it was asked', () => {
        const player = createSoundPlayer(() => null, memory());

        expect(player.state()).toBe('locked');
        player.unlock();
        expect(player.state()).toBe('on');
    });

    it('survives a browser without Web Audio', () => {
        const player = createSoundPlayer(() => null, memory());

        expect(() => {
            player.unlock();
            player.play('offer');
        }).not.toThrow();
    });
});

describe('bindSoundUnlock', () => {
    it('unlocks on the first pointer or key press and then stops listening', () => {
        const unlock = vi.fn();
        const target = document.createElement('div') as unknown as Document;
        const stop = bindSoundUnlock({ unlock }, target);

        target.dispatchEvent(new Event('keydown'));
        target.dispatchEvent(new Event('pointerdown'));

        expect(unlock).toHaveBeenCalledTimes(1);
        stop();
    });

    it('can be cancelled before any gesture', () => {
        const unlock = vi.fn();
        const target = document.createElement('div') as unknown as Document;

        bindSoundUnlock({ unlock }, target)();
        target.dispatchEvent(new Event('pointerdown'));

        expect(unlock).not.toHaveBeenCalled();
    });
});
