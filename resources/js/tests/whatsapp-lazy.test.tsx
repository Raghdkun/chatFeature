/**
 * The WhatsApp live engine (store, controller, API client, socket bindings) is loaded on demand, for administrators only: a member who is
 * not one never downloads or runs it (the dashboard's initial bundle carries only the gate). The module under test is spied on by a
 * factory that runs the first time the module is imported, so "never executed" is observable.
 */
import '@/tests/dom-polyfills';
import { setupServer } from 'msw/node';
import { useEffect } from 'react';
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { WhatsAppNavBadge } from '@/components/whatsapp/nav-badge';
import { StaffRealtimeHost } from '@/lib/realtime/staff/host';
import { makeWaChat, resetWaFixtures } from '@/lib/whatsapp/fixtures';
import { fakeEcho } from '@/tests/fake-echo';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { createStaffBackend } from '@/tests/msw/chat-staff';
import { createWaBackend } from '@/tests/msw/whatsapp';
import { render } from '@/tests/render';
import { fakeSound, waitFor } from '@/tests/staff-kit';

const engine = vi.hoisted(() => ({ loaded: 0 }));

vi.mock('@/lib/realtime/whatsapp/provider', async (importOriginal) => {
    engine.loaded += 1;

    return importOriginal();
});
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

vi.setConfig({ testTimeout: 20_000 });

const server = setupServer();
const staff = { current: createStaffBackend() };
const wa = { current: createWaBackend() };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
    resetInertiaMock();
    fakeEcho.reset();
    staff.current = createStaffBackend({ me: { id: 1, name: 'Mina' } });
    wa.current = createWaBackend();
    server.use(...staff.current.handlers, ...wa.current.handlers);
});
afterAll(() => server.close());

const user = (flags: { is_admin?: boolean; is_agent?: boolean }) => ({
    id: 1,
    name: 'Mina Haddad',
    email: 'mina@example.com',
    avatar: null,
    auth_source: 'local',
    is_admin: false,
    is_agent: false,
    ...flags,
});

const host = (flags: { is_admin?: boolean; is_agent?: boolean }) => (
    <StaffRealtimeHost
        initialPage={{
            props: { auth: { user: user(flags) }, locale: 'en' },
        }}
        sockets
        sound={fakeSound()}
    >
        <WhatsAppNavBadge />
    </StaffRealtimeHost>
);

// ORDER MATTERS: the module registry of this file remembers what an earlier test imported, so the tests that must NOT load the engine
// come first.
describe('who downloads the WhatsApp engine', () => {
    it('never an agent, and never a signed-out visitor of the app: the module is not even imported', async () => {
        const agent = await render(host({ is_agent: true }));

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(engine.loaded).toBe(0);
        expect(fakeEcho.channels().some((name) => /whatsapp/i.test(name))).toBe(
            false,
        );
        expect(wa.current.state.calls).toHaveLength(0);
        await agent.unmount();

        const guest = await render(
            <StaffRealtimeHost
                initialPage={{ props: { auth: { user: null }, locale: 'en' } }}
                sockets
                sound={fakeSound()}
            >
                <WhatsAppNavBadge />
            </StaffRealtimeHost>,
        );

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(engine.loaded).toBe(0);
        await guest.unmount();
    });

    it('an administrator gets it right after the first paint, and the live data works as before', async () => {
        wa.current.state.chats.set(
            fakeUlid(6100),
            makeWaChat({ ulid: fakeUlid(6100), unreadByAdmin: 2 }),
        );

        const view = await render(host({ is_admin: true }));

        await waitFor(() => expect(engine.loaded).toBe(1));
        await waitFor(() =>
            expect(view.byTestId('nav-badge-whatsapp')?.textContent).toContain(
                '2',
            ),
        );
        expect(fakeEcho.channels()).toContain('private:whatsapp-admin');
        await view.unmount();
    });

    it('keeps the page tree mounted while the engine arrives (the children are not re-created)', async () => {
        const lifecycle = { mounted: 0, unmounted: 0 };

        function Probe() {
            useEffect(() => {
                lifecycle.mounted += 1;

                return () => {
                    lifecycle.unmounted += 1;
                };
            }, []);

            return <WhatsAppNavBadge />;
        }

        const view = await render(
            <StaffRealtimeHost
                initialPage={{
                    props: {
                        auth: { user: user({ is_admin: true }) },
                        locale: 'en',
                    },
                }}
                sockets
                sound={fakeSound()}
            >
                <Probe />
            </StaffRealtimeHost>,
        );

        // The engine has arrived and published its session (it bound the admin channel) ...
        await waitFor(() =>
            expect(fakeEcho.channels()).toContain('private:whatsapp-admin'),
        );

        // ... and the tree below was mounted once and never torn down on the way.
        expect(lifecycle).toEqual({ mounted: 1, unmounted: 0 });
        await view.unmount();
    });
});
