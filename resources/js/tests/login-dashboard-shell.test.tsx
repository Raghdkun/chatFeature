import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { TooltipProvider } from '@/components/ui/tooltip';
import AppLayout from '@/layouts/app-layout';
import Login from '@/pages/auth/login';
import Dashboard from '@/pages/dashboard';
import { inertiaState, resetInertiaMock } from '@/tests/inertia-mock';
import { render } from '@/tests/render';
import type { Auth, AuthCapabilities } from '@/types';

// `use-mobile` calls window.matchMedia at import time, which jsdom lacks.
vi.hoisted(() => {
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
    })) as typeof window.matchMedia;
});

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

// Passkeys need WebAuthn; pretend the browser supports it so the button can be asserted.
vi.mock('@laravel/passkeys/react', () => ({
    usePasskeyVerify: () => ({
        verify: vi.fn(),
        isLoading: false,
        error: null,
        isSupported: true,
    }),
}));

const fortifyCapabilities: AuthCapabilities = {
    canRegister: true,
    canResetPassword: true,
    canManage2fa: true,
    profileEditable: true,
    portalUrl: null,
};

const portalCapabilities: AuthCapabilities = {
    canRegister: false,
    canResetPassword: false,
    canManage2fa: false,
    profileEditable: false,
    portalUrl: 'https://auth.example.test',
};

const guest = (
    mode: Auth['mode'],
    capabilities: AuthCapabilities,
): Record<string, unknown> => ({
    auth: { user: null, mode, capabilities },
});

const user = (overrides: Partial<NonNullable<Auth['user']>> = {}) => ({
    id: 1,
    name: 'Mina Haddad',
    email: 'mina@example.com',
    avatar: null,
    is_admin: false,
    is_agent: true,
    auth_source: 'local',
    ...overrides,
});

beforeEach(() => resetInertiaMock());

describe('login page', () => {
    it('keeps the starter kit behaviours in local auth mode', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));

        const view = await render(<Login />);

        expect(
            view.container.querySelector('input[name="email"]'),
        ).not.toBeNull();
        expect(
            view.container.querySelector('input[name="password"]'),
        ).not.toBeNull();
        expect(
            view.container.querySelector('button[role="checkbox"]#remember'),
        ).not.toBeNull();
        expect(view.text()).toContain('Forgot your password?');
        expect(view.text()).toContain('Sign up');
        expect(view.text()).toContain('Sign in with a passkey');
        expect(view.byTestId('login-portal-hint')).toBeNull();
        expect(view.byTestId('login-no-chat-access')).toBeNull();
    });

    it('hides register, reset and passkeys when the driver cannot honour them', async () => {
        resetInertiaMock(
            guest('fortify', {
                ...fortifyCapabilities,
                canRegister: false,
                canResetPassword: false,
                canManage2fa: false,
            }),
        );

        const view = await render(<Login />);

        expect(view.text()).not.toContain('Forgot your password?');
        expect(view.text()).not.toContain('Sign up');
        expect(view.text()).not.toContain('Sign in with a passkey');
    });

    it('renders the Auth Portal variant for pizzasys mode', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));

        const view = await render(<Login />);
        const portal = view.byTestId('login-portal-hint');
        const link = portal?.querySelector('a');

        expect(portal?.textContent).toContain('Auth Portal');
        expect(link?.getAttribute('href')).toBe('https://auth.example.test/');
        expect(link?.getAttribute('rel')).toContain('noopener');
        expect(
            view.container.querySelector('input[name="email"]'),
        ).not.toBeNull();
        expect(view.text()).not.toContain('Sign up');
        expect(view.text()).not.toContain('Sign in with a passkey');
        expect(view.text()).toContain('Reset it in the portal');
    });

    it('never renders a non-web portal URL as a link', async () => {
        resetInertiaMock(
            guest('pizzasys', {
                ...portalCapabilities,
                portalUrl: 'javascript:alert(1)',
            }),
        );

        const view = await render(<Login />);

        expect(
            view.byTestId('login-portal-hint')?.querySelector('a'),
        ).toBeNull();
    });

    it('titles the page after the auth mode (layout)', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));

        const Layout = Login.layout;
        const portal = await render(
            <Layout>
                <span />
            </Layout>,
        );

        expect(portal.container.querySelector('h1')?.textContent).toBe(
            'Sign in with Auth Portal',
        );

        resetInertiaMock(guest('fortify', fortifyCapabilities));

        const local = await render(
            <Layout>
                <span />
            </Layout>,
        );

        expect(local.container.querySelector('h1')?.textContent).toBe(
            'Log in to your account',
        );
    });

    it('explains clearly when the account has no chat access (reason prop)', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));

        const view = await render(<Login reason="no_chat_access" />);
        const alert = view.byTestId('login-no-chat-access');

        expect(alert?.getAttribute('role')).toBe('alert');
        expect(alert?.textContent).toContain('No chat access');
        expect(alert?.textContent).toContain('not an admin or an agent');
    });

    it('shows the backend message once: in the notice, not again under the field', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));
        // What the backend sends: the message under `email` plus the `reason` flash.
        inertiaState.formErrors = {
            email: 'This account has no access to the chat dashboard.',
        };

        const view = await render(<Login reason="no_chat_access" />);

        expect(view.byTestId('login-no-chat-access')).not.toBeNull();
        expect(view.text()).not.toContain(
            'This account has no access to the chat dashboard.',
        );
    });

    it('also recognises the validation error key `access`', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));
        inertiaState.formErrors = { access: 'no_chat_access' };

        const view = await render(<Login />);

        expect(view.byTestId('login-no-chat-access')).not.toBeNull();
    });

    it('shows the ordinary credential error inline, without the access alert', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));
        inertiaState.formErrors = { email: 'These credentials do not match.' };

        const view = await render(<Login />);

        expect(view.text()).toContain('These credentials do not match.');
        expect(view.byTestId('login-no-chat-access')).toBeNull();
    });
});

describe('dashboard', () => {
    // Radix measures the switch with ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );

    it('gives admins a "set up your first widget" checklist', async () => {
        resetInertiaMock({
            auth: {
                user: user({ is_admin: true, is_agent: false }),
                mode: 'fortify',
                capabilities: fortifyCapabilities,
            },
        });

        const view = await render(<Dashboard />);

        expect(view.container.querySelector('h1')?.textContent).toBe(
            'Welcome back, Mina',
        );
        expect(view.byTestId('dashboard-admin-setup')?.textContent).toContain(
            'Set up your first widget',
        );
        for (const key of ['category', 'widget', 'agents', 'embed']) {
            expect(view.byTestId(`dashboard-admin-step-${key}`)).not.toBeNull();
        }
        expect(view.byTestId('dashboard-queue')).not.toBeNull();
        expect(view.byTestId('dashboard-agent-waiting')).toBeNull();
    });

    it('gives agents a waiting state with the availability control (the real status select, no placeholder switch)', async () => {
        resetInertiaMock({
            auth: {
                user: user(),
                mode: 'fortify',
                capabilities: fortifyCapabilities,
            },
        });

        const view = await render(<Dashboard />);

        expect(view.byTestId('dashboard-agent-waiting')?.textContent).toContain(
            'Waiting for chats',
        );
        expect(view.byTestId('dashboard-admin-setup')).toBeNull();
        expect(view.byTestId('dashboard-availability')?.textContent).toContain(
            'Available for new chats',
        );

        // The placeholder switch and its "presence is not connected yet" note are gone.
        expect(view.byTestId('dashboard-availability-switch')).toBeNull();
        expect(
            view.byTestId('dashboard-availability')?.textContent,
        ).not.toMatch(/not connected yet|previews the control/i);

        // Without a staff session (this bare render has none) the status is unknown: the select is there but waits.
        const select = view.byTestId('presence-select') as HTMLSelectElement;

        expect(select.tagName).toBe('SELECT');
        expect(select.disabled).toBe(true);
    });

    it('labels the status select for assistive tech', async () => {
        resetInertiaMock({
            auth: {
                user: user(),
                mode: 'fortify',
                capabilities: fortifyCapabilities,
            },
        });

        const view = await render(<Dashboard />);
        const select = view.byTestId('presence-select');
        const label = view.container.querySelector(
            `label[for="${select?.id}"]`,
        );

        expect(select?.id).not.toBe('');
        expect(label?.textContent).toBe('Your status');
        expect(
            view.container.querySelector('#dashboard-availability-title')
                ?.textContent,
        ).toBe('Available for new chats');
        expect(
            view
                .byTestId('dashboard-availability')
                ?.getAttribute('aria-labelledby'),
        ).toBe('dashboard-availability-title');
    });
});

describe('app shell', () => {
    const shell = (overrides: Record<string, unknown> = {}) =>
        resetInertiaMock({
            auth: {
                user: user({ is_admin: true, is_agent: false }),
                mode: 'fortify',
                capabilities: fortifyCapabilities,
            },
            sidebarOpen: true,
            ...overrides,
        });

    it('builds the sidebar from the nav registry, names the app and shows the role', async () => {
        shell({ name: 'Acme Support' });

        const view = await render(
            <TooltipProvider>
                <AppLayout
                    breadcrumbs={[{ title: 'Dashboard', href: '/dashboard' }]}
                >
                    <p data-testid="page">page</p>
                </AppLayout>
            </TooltipProvider>,
        );
        const sidebar = view.container.querySelector('[data-slot="sidebar"]');

        expect(sidebar?.textContent).toContain('Acme Support');
        expect(sidebar?.textContent).toContain('Platform');
        expect(sidebar?.textContent).toContain('Dashboard');
        expect(sidebar?.textContent).toContain('Mina Haddad');
        expect(sidebar?.textContent).toContain('Administrator');
        expect(view.byTestId('header-role')?.textContent).toBe('Administrator');
        expect(view.byTestId('page')).not.toBeNull();
    });

    it('drops the starter kit footer links', async () => {
        shell();

        const view = await render(
            <TooltipProvider>
                <AppLayout>
                    <p />
                </AppLayout>
            </TooltipProvider>,
        );

        expect(view.text()).not.toContain('Repository');
        expect(view.text()).not.toContain('Documentation');
    });

    it('offers a skip link to the main landmark', async () => {
        shell();

        const view = await render(
            <TooltipProvider>
                <AppLayout>
                    <p />
                </AppLayout>
            </TooltipProvider>,
        );
        const skip = view.container.querySelector('a[href="#main-content"]');

        expect(skip?.textContent).toBe('Skip to main content');
        expect(
            view.container.querySelector('main#main-content'),
        ).not.toBeNull();
    });

    it('puts the sidebar on the left in ltr and flips it to the right in rtl', async () => {
        shell();

        const ltr = await render(
            <TooltipProvider>
                <AppLayout>
                    <p />
                </AppLayout>
            </TooltipProvider>,
        );

        expect(
            ltr.container
                .querySelector('[data-slot="sidebar"]')
                ?.getAttribute('data-side'),
        ).toBe('left');

        shell({ locale: 'ar', direction: 'rtl' });

        const rtl = await render(
            <TooltipProvider>
                <AppLayout>
                    <p />
                </AppLayout>
            </TooltipProvider>,
        );

        expect(
            rtl.container
                .querySelector('[data-slot="sidebar"]')
                ?.getAttribute('data-side'),
        ).toBe('right');
        expect(document.documentElement.dir).toBe('rtl');
    });
});
