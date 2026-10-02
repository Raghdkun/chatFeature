import '@/tests/dom-polyfills';
import { act, useState } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    fakeTime,
    makeActiveConversationStaff,
    makeConversationStaff,
    resetFixtures,
} from '@/lib/chat/fixtures';
import {
    createStaffSession,
    StaffRealtimeHost,
} from '@/lib/realtime/staff/host';
import { ApiError } from '@/lib/api-client';
import type { StaffApi } from '@/lib/chat-api/staff';
import { toast } from 'sonner';
import {
    useInbox,
    useInboxOptional,
    useStaffRealtimeOptional,
} from '@/lib/realtime/staff/context';
import { fakeEcho } from '@/tests/fake-echo';
import { fireRouterEvent, resetInertiaMock } from '@/tests/inertia-mock';
import { render } from '@/tests/render';
import { AGENT, fakeSound, useStaffBackend, waitFor } from '@/tests/staff-kit';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('@laravel/echo-react', async () =>
    (await import('@/tests/fake-echo')).fakeEchoModule(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

// The network and the clock are real here: a loaded machine (CI, parallel agents) must not turn a slow tick into a failure.
vi.setConfig({ testTimeout: 20_000 });

const backend = useStaffBackend();

const staffUser = {
    id: AGENT.id,
    name: 'Sam',
    is_admin: false,
    is_agent: true,
};
const page = (user: Record<string, unknown> | null, locale = 'en') => ({
    props: { auth: { user }, locale },
});

function Probe() {
    const session = useStaffRealtimeOptional();
    const connection = useInboxOptional((state) => state.connection);
    const [renders, setRenders] = useState(0);

    return (
        <p
            data-testid="probe"
            data-session={session ? 'yes' : 'no'}
            data-renders={renders}
            data-connection={connection ?? 'none'}
        >
            <button
                data-testid="bump"
                onClick={() => setRenders((n) => n + 1)}
            />
        </p>
    );
}

beforeEach(() => {
    resetFixtures();
    resetInertiaMock();
    fakeEcho.reset();
});

afterEach(() => vi.clearAllMocks());

describe('who gets a session', () => {
    it('gives none to a guest or to an account without a chat role, and opens no websocket', async () => {
        for (const user of [
            null,
            { id: 3, name: 'Nobody', is_admin: false, is_agent: false },
        ]) {
            const view = await render(
                <StaffRealtimeHost
                    initialPage={page(user)}
                    sockets
                    sound={fakeSound()}
                >
                    <Probe />
                </StaffRealtimeHost>,
            );

            expect(view.byTestId('probe')?.getAttribute('data-session')).toBe(
                'no',
            );
            expect(fakeEcho.channels()).toEqual([]);
            await view.unmount();
        }
    });

    it("opens the websocket when the server's shared realtime prop names Reverb, even in a build without VITE_REVERB_*", async () => {
        const view = await render(
            <StaffRealtimeHost
                initialPage={{
                    props: {
                        ...page(staffUser).props,
                        realtime: {
                            key: 'k',
                            host: 'ws.chat.example',
                            port: 443,
                            scheme: 'https',
                        },
                    },
                }}
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        expect(fakeEcho.channels()).toContain(`private:staff.${AGENT.id}`);
        await view.unmount();
    });

    it('falls back to the build-time address only when the server sent no realtime prop at all', async () => {
        vi.stubEnv('VITE_REVERB_APP_KEY', 'build-key');
        vi.stubEnv('VITE_REVERB_HOST', 'build.example');

        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        expect(fakeEcho.channels()).toContain(`private:staff.${AGENT.id}`);
        await view.unmount();
        vi.unstubAllEnvs();
    });

    it('polls silently when the server says realtime is off (realtime: null), even in a build that has a Reverb address', async () => {
        vi.stubEnv('VITE_REVERB_APP_KEY', 'build-key');
        vi.stubEnv('VITE_REVERB_HOST', 'build.example');

        const errors = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const warnings = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);

        try {
            const view = await render(
                <StaffRealtimeHost
                    initialPage={{
                        props: { ...page(staffUser).props, realtime: null },
                    }}
                    sound={fakeSound()}
                >
                    <Probe />
                </StaffRealtimeHost>,
            );

            // no channel subscribed, no connection attempt: the dashboard polls and says so
            expect(fakeEcho.channels()).toEqual([]);
            expect(
                view.byTestId('probe')?.getAttribute('data-connection'),
            ).toBe('unavailable');
            expect(errors).not.toHaveBeenCalled();
            expect(warnings).not.toHaveBeenCalled();
            await view.unmount();
        } finally {
            errors.mockRestore();
            warnings.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('stays on REST polling when neither the prop nor the build has an address', async () => {
        vi.stubEnv('VITE_REVERB_APP_KEY', '');

        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        expect(fakeEcho.channels()).toEqual([]);
        expect(view.byTestId('probe')?.getAttribute('data-connection')).toBe(
            'unavailable',
        );
        await view.unmount();
        vi.unstubAllEnvs();
    });

    it('gives one to an agent: the staff channel and the roster, not the admin channel', async () => {
        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        expect(view.byTestId('probe')?.getAttribute('data-session')).toBe(
            'yes',
        );
        expect(fakeEcho.channels()).toEqual(
            expect.arrayContaining([
                `private:staff.${AGENT.id}`,
                'presence:staff',
            ]),
        );
        expect(fakeEcho.channels()).not.toContain('private:admin');
    });

    it('opens no websocket at all when the build has none, and polls instead', async () => {
        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets={false}
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        expect(fakeEcho.channels()).toEqual([]);
        expect(view.byTestId('probe')?.getAttribute('data-session')).toBe(
            'yes',
        );
    });
});

describe('across page visits', () => {
    it('starts a session when somebody signs in, without remounting the page', async () => {
        const view = await render(
            <StaffRealtimeHost
                initialPage={page(null)}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        await act(async () => view.byTestId('bump')?.click());
        expect(view.byTestId('probe')?.getAttribute('data-renders')).toBe('1');
        expect(view.byTestId('probe')?.getAttribute('data-session')).toBe('no');

        await act(async () =>
            fireRouterEvent('navigate', { page: page(staffUser) }),
        );

        expect(view.byTestId('probe')?.getAttribute('data-session')).toBe(
            'yes',
        );
        // The page below kept its own state: the host did not rebuild the tree around it.
        expect(view.byTestId('probe')?.getAttribute('data-renders')).toBe('1');
        expect(fakeEcho.channels()).toContain(`private:staff.${AGENT.id}`);
    });

    it('keeps the same session (store, timers, socket) while the same person navigates', async () => {
        let seen: unknown[] = [];

        function Capture() {
            seen = [...seen, useStaffRealtimeOptional()?.store];

            return null;
        }

        await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Capture />
            </StaffRealtimeHost>,
        );
        await act(async () =>
            fireRouterEvent('navigate', { page: page(staffUser) }),
        );
        await act(async () =>
            fireRouterEvent('navigate', {
                page: page({ ...staffUser, name: 'Sam Renamed' }),
            }),
        );

        expect(new Set(seen).size).toBe(1);
    });

    it('ends the session on sign-out and stops listening', async () => {
        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        await act(async () =>
            fireRouterEvent('navigate', { page: page(null) }),
        );

        expect(view.byTestId('probe')?.getAttribute('data-session')).toBe('no');
        expect(fakeEcho.channels()).toEqual([]);
    });
});

describe('lifecycle', () => {
    it('unlocks the sounds on the first gesture, once', async () => {
        const sound = fakeSound();

        await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={sound}
            >
                <Probe />
            </StaffRealtimeHost>,
        );
        document.dispatchEvent(new Event('pointerdown'));
        document.dispatchEvent(new Event('keydown'));

        expect(sound.unlock).toHaveBeenCalledTimes(1);
    });

    it('re-reads the lists when the tab comes back and when the network returns', async () => {
        const waiting = makeConversationStaff();

        backend.current.state.conversations.set(waiting.ulid, waiting);
        await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );
        await waitFor(() =>
            expect(
                backend.current.calls('GET', '/api/v1/conversations/queue')
                    .length,
            ).toBeGreaterThanOrEqual(1),
        );

        const before = backend.current.calls(
            'GET',
            '/api/v1/conversations/queue',
        ).length;

        Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            configurable: true,
        });
        await act(async () =>
            document.dispatchEvent(new Event('visibilitychange')),
        );
        await waitFor(() =>
            expect(
                backend.current.calls('GET', '/api/v1/conversations/queue')
                    .length,
            ).toBe(before + 1),
        );

        await act(async () => window.dispatchEvent(new Event('online')));
        await waitFor(() =>
            expect(
                backend.current.calls('GET', '/api/v1/conversations/queue')
                    .length,
            ).toBe(before + 2),
        );
    });

    it('says its tab is visible with the first heartbeat and beats again at once when the tab comes back to the foreground', async () => {
        backend.current.state.presence = 'online';
        await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        const beats = () =>
            backend.current.calls('POST', '/api/v1/me/presence/heartbeat');

        await waitFor(() => expect(beats().length).toBe(1));
        expect(beats()[0].body).toEqual({ visible: true });

        const setVisibility = async (state: 'hidden' | 'visible') => {
            Object.defineProperty(document, 'visibilityState', {
                value: state,
                configurable: true,
            });
            await act(async () =>
                document.dispatchEvent(new Event('visibilitychange')),
            );
        };

        // Going to the background sends nothing (the next interval beat will say `visible: false`); coming back beats at once.
        await setVisibility('hidden');
        expect(beats().length).toBe(1);

        await setVisibility('visible');
        await waitFor(() => expect(beats().length).toBe(2));
        expect(beats()[1].body).toEqual({ visible: true });
    });

    it('keeps the session alive when a tab that was hidden for a long time comes back, and not after a short absence', async () => {
        let clock = Date.now();

        await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
                now={() => clock}
            >
                <Probe />
            </StaffRealtimeHost>,
        );
        await waitFor(() =>
            expect(
                backend.current.calls('GET', '/api/v1/conversations/queue')
                    .length,
            ).toBeGreaterThanOrEqual(1),
        );

        const setVisibility = async (state: 'hidden' | 'visible') => {
            Object.defineProperty(document, 'visibilityState', {
                value: state,
                configurable: true,
            });
            await act(async () =>
                document.dispatchEvent(new Event('visibilitychange')),
            );
        };
        const queueReads = () =>
            backend.current.calls('GET', '/api/v1/conversations/queue').length;
        const keepAlives = () =>
            backend.current.calls('GET', '/session/keepalive').length;

        await setVisibility('hidden');
        clock += 60_000;
        const before = queueReads();
        await setVisibility('visible');
        // The lists are re-read at once, the session is not touched after a minute away.
        await waitFor(() => expect(queueReads()).toBe(before + 1));
        expect(keepAlives()).toBe(0);

        await setVisibility('hidden');
        clock += 11 * 60_000;
        await setVisibility('visible');
        await waitFor(() => expect(keepAlives()).toBe(1));

        await setVisibility('visible');
    });

    it('takes the first snapshot over REST on a page that did not bring one', async () => {
        const waiting = makeConversationStaff();
        const mine = makeActiveConversationStaff({
            assignedAgent: { id: AGENT.id, name: 'Sam' },
            lastMessageAt: fakeTime(5),
        });

        backend.current.state.conversations.set(waiting.ulid, waiting);
        backend.current.state.conversations.set(mine.ulid, mine);

        function Read() {
            const queue = useInbox((s) => s.queue.length);
            const chats = useInbox((s) => s.mine.length);

            return <p data-testid="counts">{`${queue}/${chats}`}</p>;
        }

        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Read />
            </StaffRealtimeHost>,
        );

        await waitFor(() =>
            expect(view.byTestId('counts')?.textContent).toBe('1/1'),
        );
    });

    it('survives a websocket that cannot be created: the page renders and falls back to polling', async () => {
        fakeEcho.failConnection(
            new Error(
                'You must pass your app key when you instantiate Pusher.',
            ),
        );
        const errors = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const view = await render(
            <StaffRealtimeHost
                initialPage={page(staffUser)}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        errors.mockRestore();

        expect(view.byTestId('probe')?.getAttribute('data-session')).toBe(
            'yes',
        );
        expect(view.byTestId('probe')?.getAttribute('data-connection')).toBe(
            'unavailable',
        );
    });
});

describe('the browser sign-out', () => {
    it('says so, then leaves through a hard navigation so the server shows the sign-in page', async () => {
        const assign = vi.fn();
        const original = window.location;
        const api = {
            presence: vi.fn().mockRejectedValue(
                new ApiError({
                    status: 401,
                    code: 'session_revoked',
                    message: 'Ended.',
                }),
            ),
            queue: vi.fn().mockResolvedValue([]),
            conversations: vi.fn().mockResolvedValue([]),
            heartbeat: vi.fn(),
        };

        Object.defineProperty(window, 'location', {
            value: { assign } as unknown as Location,
            configurable: true,
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        try {
            const session = createStaffSession({
                user: { id: AGENT.id, isAdmin: false, isAgent: true },
                translate: (key) => key,
                sockets: false,
                sound: fakeSound(),
                api: api as unknown as StaffApi,
            });

            session.controller.handle('session.revoked', {
                v: 1,
                reason: 'deactivated',
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(toast.error).toHaveBeenCalledWith('inbox.session.ended');
            expect(assign).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1300);
            expect(assign).toHaveBeenCalledWith('/dashboard');
        } finally {
            vi.useRealTimers();
            Object.defineProperty(window, 'location', {
                value: original,
                configurable: true,
            });
        }
    });
});
