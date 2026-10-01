/**
 * Everything a staff dashboard test needs besides its own `vi.mock` calls (those are hoisted per file, so each test file declares them):
 *
 *   vi.mock('@inertiajs/react', async () => (await import('@/tests/inertia-mock')).inertiaMock());
 *   vi.mock('@laravel/echo-react', async () => (await import('@/tests/fake-echo')).fakeEchoModule());
 *   vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));
 *
 * `useStaffBackend()` starts an MSW server with the stateful fake of the management API; `renderStaff()` mounts the real
 * `StaffRealtimeHost` (store, controller, Echo bindings) around the page under test.
 */
import '@/tests/dom-polyfills';
import { setupServer } from 'msw/node';
import { act, type ReactElement } from 'react';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    vi,
    type Mock,
} from 'vite-plus/test';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
    useStaffRealtimeContext,
    type StaffRealtimeContextValue,
} from '@/lib/realtime/staff/context';
import type { StaffApi } from '@/lib/chat-api/staff';
import type { StaffEffects } from '@/lib/realtime/staff/controller';
import { StaffRealtimeHost } from '@/lib/realtime/staff/host';
import type { SoundPlayer } from '@/lib/realtime/staff/sound';
import { fakeEcho } from '@/tests/fake-echo';
import { resetInertiaMock } from '@/tests/inertia-mock';
import {
    createStaffBackend,
    type StaffBackend,
    type StaffBackendOptions,
} from '@/tests/msw/chat-staff';
import { render, type Rendered } from '@/tests/render';

export type TestViewer = {
    id: number;
    name: string;
    isAdmin: boolean;
    isAgent: boolean;
};

export const AGENT: TestViewer = {
    id: 7,
    name: 'Sam',
    isAdmin: false,
    isAgent: true,
};
export const ADMIN: TestViewer = {
    id: 1,
    name: 'Ada',
    isAdmin: true,
    isAgent: true,
};

/** Starts the fake management API for the tests of the current file; `backend` is replaced for every test (fresh state). */
export function useStaffBackend(options: StaffBackendOptions = {}): {
    current: StaffBackend;
    /** The MSW server, to override one route for a single test (`backend.server.use(http.post(...))`). */
    server: ReturnType<typeof setupServer>;
} {
    const server = setupServer();
    const holder = { current: createStaffBackend(options), server };

    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    beforeEach(() => {
        holder.current = createStaffBackend(options);
        server.use(...holder.current.handlers);
    });
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    return holder;
}

export type FakeSound = Omit<SoundPlayer, 'play' | 'unlock'> & {
    play: Mock<SoundPlayer['play']>;
    unlock: Mock<SoundPlayer['unlock']>;
};

export function fakeSound(): FakeSound {
    let muted = false;
    const listeners = new Set<() => void>();

    return {
        unlock: vi.fn<SoundPlayer['unlock']>(),
        play: vi.fn<SoundPlayer['play']>(),
        isMuted: () => muted,
        state: () => (muted ? 'muted' : 'on'),
        setMuted: (next: boolean) => {
            muted = next;
            listeners.forEach((listener) => listener());
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export type StaffRender = {
    view: Rendered;
    session: StaffRealtimeContextValue;
    sound: FakeSound;
};

/** Mount `ui` inside the real staff host, signed in as `viewer`, with a websocket (the fake Echo) unless `sockets: false`. */
export async function renderStaff(
    ui: ReactElement,
    options: {
        viewer?: TestViewer;
        sockets?: boolean;
        locale?: string;
        /** Replace browser side effects (sign-out, ...). */
        effects?: Partial<StaffEffects>;
        /** A different API client (e.g. one that does not reload the page on a 401). */
        api?: StaffApi;
    } = {},
): Promise<StaffRender> {
    const viewer = options.viewer ?? AGENT;
    const locale = options.locale ?? 'en';
    const user = {
        id: viewer.id,
        name: viewer.name,
        email: `${viewer.name.toLowerCase()}@example.com`,
        avatar: null,
        is_admin: viewer.isAdmin,
        is_agent: viewer.isAgent,
        auth_source: 'local',
    };
    const sound = fakeSound();
    let captured: StaffRealtimeContextValue | null = null;

    resetInertiaMock({
        locale,
        auth: { user, mode: 'fortify', capabilities: { portalUrl: null } },
    });
    fakeEcho.reset();

    function Capture() {
        captured = useStaffRealtimeContext();

        return null;
    }

    const view = await render(
        <TooltipProvider>
            <StaffRealtimeHost
                initialPage={{ props: { auth: { user }, locale } }}
                sockets={options.sockets ?? true}
                sound={sound}
                effects={options.effects}
                api={options.api}
            >
                <Capture />
                {ui}
            </StaffRealtimeHost>
        </TooltipProvider>,
    );

    if (!captured) {
        throw new Error('The staff session was not created.');
    }

    return { view, session: captured, sound };
}

/** Re-run `assertion` (letting React and the network settle between tries) until it passes or the timeout is hit. */
export async function waitFor(
    assertion: () => void,
    timeoutMs = 5000,
): Promise<void> {
    const started = Date.now();

    for (;;) {
        try {
            assertion();

            return;
        } catch (error) {
            if (Date.now() - started > timeoutMs) {
                throw error;
            }

            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
            });
        }
    }
}
