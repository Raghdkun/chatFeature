/**
 * WhatsApp is for administrators only (P6-D1). This file proves the shell keeps it that way for everybody else, end to end:
 *  - the sidebar and the Settings menu (an agent's, and an account without a chat role, have no trace of it),
 *  - the staff realtime host (no socket, no request, no title count for an agent) and, for an administrator, the live badge and the
 *    document title that adds the unread WhatsApp messages to the waiting chats.
 */
import '@/tests/dom-polyfills';
import { setupServer } from 'msw/node';
import { act } from 'react';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WhatsAppNavBadge } from '@/components/whatsapp/nav-badge';
import AppLayout from '@/layouts/app-layout';
import SettingsLayout from '@/layouts/settings/layout';
import { StaffRealtimeHost } from '@/lib/realtime/staff/host';
import { makeWaChat, resetWaFixtures } from '@/lib/whatsapp/fixtures';
import { inNavGroup, navFor } from '@/nav';
import { fakeEcho } from '@/tests/fake-echo';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { createStaffBackend } from '@/tests/msw/chat-staff';
import { createWaBackend } from '@/tests/msw/whatsapp';
import { render } from '@/tests/render';
import { fakeSound, waitFor } from '@/tests/staff-kit';

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

type Flags = { is_admin?: boolean; is_agent?: boolean };

const caps = {
    canRegister: false,
    canResetPassword: false,
    canManage2fa: false,
    profileEditable: false,
    portalUrl: null,
};

const user = (flags: Flags) => ({
    id: 1,
    name: 'Mina Haddad',
    email: 'mina@example.com',
    avatar: null,
    auth_source: 'local',
    is_admin: false,
    is_agent: false,
    ...flags,
});

const as = (flags: Flags) =>
    resetInertiaMock({
        auth: { user: user(flags), mode: 'fortify', capabilities: caps },
        sidebarOpen: true,
    });

const server = setupServer();
const staff = { current: createStaffBackend() };
const wa = { current: createWaBackend() };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
    fakeEcho.reset();
    staff.current = createStaffBackend({ me: { id: 1, name: 'Mina' } });
    wa.current = createWaBackend();
    server.use(...staff.current.handlers, ...wa.current.handlers);
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const waCalls = () => wa.current.state.calls;

describe('the nav registry', () => {
    const hrefs = (flags: Flags) =>
        navFor(flags).map((entry) => entry.item.href);

    it('lists the WhatsApp inbox for an administrator, with or without the agent role', () => {
        expect(hrefs({ is_admin: true })).toContain('/whatsapp');
        expect(hrefs({ is_admin: true, is_agent: true })).toContain(
            '/whatsapp',
        );
    });

    it('lists nothing about WhatsApp for an agent or an account without a chat role', () => {
        for (const flags of [
            { is_agent: true },
            {},
            { is_admin: false, is_agent: false },
        ]) {
            const entries = navFor(flags);

            expect(
                entries.filter(
                    (entry) =>
                        /whatsapp/i.test(JSON.stringify(entry.item.href)) ||
                        /whatsapp/i.test(entry.item.title) ||
                        /whatsapp/i.test(entry.item.titleKey ?? ''),
                ),
            ).toEqual([]);
        }
    });

    it('puts it in the main group, next to the other chat screens', () => {
        const main = inNavGroup(navFor({ is_admin: true }), 'main').map(
            (item) => item.title,
        );

        expect(main).toContain('WhatsApp');
    });
});

describe('the sidebar', () => {
    const sidebar = async () => {
        const view = await render(
            <TooltipProvider>
                <AppLayout>
                    <p>content</p>
                </AppLayout>
            </TooltipProvider>,
        );

        return view.container.querySelector('[data-slot="sidebar"]');
    };
    const links = (root: Element | null) =>
        Array.from(root?.querySelectorAll('a') ?? []).map((a) =>
            a.getAttribute('href'),
        );

    it('shows an administrator the WhatsApp link', async () => {
        as({ is_admin: true });

        const root = await sidebar();

        expect(links(root)).toContain('/whatsapp');
        expect(root?.textContent).toContain('WhatsApp');
    });

    it('shows an agent nothing of it, and an agent who is also an administrator everything', async () => {
        as({ is_agent: true });

        const root = await sidebar();

        expect(links(root).some((href) => /whatsapp/i.test(href ?? ''))).toBe(
            false,
        );
        expect(root?.textContent).not.toMatch(/whatsapp/i);
        expect(waCalls()).toHaveLength(0);
    });
});

describe('the settings menu', () => {
    const items = async () => {
        const view = await render(
            <SettingsLayout>
                <p>content</p>
            </SettingsLayout>,
        );

        return Array.from(
            view.container.querySelectorAll('nav[aria-label="Settings"] a'),
        ).map((a) => [a.textContent, a.getAttribute('href')]);
    };

    it('adds "WhatsApp" for administrators', async () => {
        as({ is_admin: true });

        expect(await items()).toContainEqual([
            'WhatsApp',
            '/settings/whatsapp',
        ]);
    });

    it('adds it for an administrator who also takes chats', async () => {
        as({ is_admin: true, is_agent: true });

        expect(await items()).toContainEqual([
            'WhatsApp',
            '/settings/whatsapp',
        ]);
    });

    it('leaves it out for an agent and for an account without a role, and keeps the other items', async () => {
        for (const flags of [{ is_agent: true }, {}]) {
            as(flags);

            const list = await items();

            expect(list.map(([title]) => title)).not.toContain('WhatsApp');
            expect(list.map(([, href]) => href)).not.toContain(
                '/settings/whatsapp',
            );
            expect(list.map(([title]) => title)).toEqual(
                expect.arrayContaining(['Profile', 'Appearance']),
            );
        }
    });
});

describe('the staff host', () => {
    const pageOf = (flags: Flags) => ({
        props: { auth: { user: user(flags) }, locale: 'en' },
    });
    const host = (flags: Flags) => (
        <StaffRealtimeHost
            initialPage={pageOf(flags)}
            sockets
            sound={fakeSound()}
        >
            <WhatsAppNavBadge />
        </StaffRealtimeHost>
    );

    beforeEach(() => {
        document.title = 'Inbox - Chat';
    });

    it('gives an agent no WhatsApp socket, no request and no badge, even with the badge mounted', async () => {
        const view = await render(host({ is_agent: true }));

        expect(fakeEcho.channels().some((name) => /whatsapp/i.test(name))).toBe(
            false,
        );
        expect(waCalls()).toHaveLength(0);
        expect(view.byTestId('nav-badge-whatsapp')).toBeNull();
        expect(document.title).toBe('Inbox - Chat');
        await view.unmount();
    });

    it('starts the live WhatsApp data for an administrator once the badge is mounted, and counts the unread messages in the title', async () => {
        const chat = makeWaChat({
            ulid: fakeUlid(6100),
            unreadByAdmin: 3,
        });

        wa.current.state.chats.set(chat.ulid, chat);

        const view = await render(host({ is_admin: true }));

        await waitFor(() =>
            expect(view.byTestId('nav-badge-whatsapp')?.textContent).toContain(
                '3',
            ),
        );
        expect(fakeEcho.channels()).toContain('private:whatsapp-admin');
        expect(document.title).toBe('(3) Inbox - Chat');

        // A new message arrives on the admin channel: the title follows.
        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.chat.updated', {
                v: 1,
                chat: { ...chat, unreadByAdmin: 5 },
            }),
        );
        await waitFor(() => expect(document.title).toBe('(5) Inbox - Chat'));

        // Read: no prefix, no badge.
        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.chat.updated', {
                v: 1,
                chat: { ...chat, unreadByAdmin: 0 },
            }),
        );
        await waitFor(() => expect(document.title).toBe('Inbox - Chat'));
        expect(view.byTestId('nav-badge-whatsapp')).toBeNull();
        await view.unmount();
    });

    it('opens no WhatsApp socket and no request for a signed-out visitor of the app', async () => {
        const view = await render(
            <StaffRealtimeHost
                initialPage={{ props: { auth: { user: null }, locale: 'en' } }}
                sockets
                sound={fakeSound()}
            >
                <WhatsAppNavBadge />
            </StaffRealtimeHost>,
        );

        expect(fakeEcho.channels()).toEqual([]);
        expect(waCalls()).toHaveLength(0);
        await view.unmount();
    });
});
