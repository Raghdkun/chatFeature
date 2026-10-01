import '@/tests/polyfills';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import Login from '@/pages/auth/login';
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

vi.mock('@laravel/passkeys/react', () => ({
    usePasskeyVerify: () => ({
        verify: vi.fn(),
        isLoading: false,
        error: null,
        isSupported: true,
    }),
}));

const portalCapabilities: AuthCapabilities = {
    canRegister: false,
    canResetPassword: false,
    canManage2fa: false,
    profileEditable: false,
    portalUrl: 'https://auth.example.test/app',
};

const fortifyCapabilities: AuthCapabilities = {
    canRegister: true,
    canResetPassword: true,
    canManage2fa: true,
    profileEditable: true,
    portalUrl: null,
};

const guest = (
    mode: Auth['mode'],
    capabilities: AuthCapabilities,
): Record<string, unknown> => ({
    auth: { user: null, mode, capabilities },
});

beforeEach(() => resetInertiaMock());

describe('Auth Portal login: where you are signing in', () => {
    it('shows the portal host as a small hint', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));

        const view = await render(<Login />);

        expect(view.byTestId('login-portal-host')?.textContent).toBe(
            'You will sign in through auth.example.test.',
        );
    });

    it('keeps the host hint for a portal on a local port', async () => {
        resetInertiaMock(
            guest('pizzasys', {
                ...portalCapabilities,
                portalUrl: 'http://localhost:8201',
            }),
        );

        const view = await render(<Login />);

        expect(view.byTestId('login-portal-host')?.textContent).toContain(
            'localhost:8201',
        );
    });

    it('shows no host when the portal URL is missing or not a web address', async () => {
        for (const portalUrl of [null, 'javascript:alert(1)', 'not a url']) {
            resetInertiaMock(
                guest('pizzasys', { ...portalCapabilities, portalUrl }),
            );

            const view = await render(<Login />);

            expect(view.byTestId('login-portal-host')).toBeNull();
            expect(view.byTestId('login-portal-hint')).not.toBeNull();
            await view.unmount();
        }
    });

    it('does not show it for local sign-in', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));

        const view = await render(<Login />);

        expect(view.byTestId('login-portal-host')).toBeNull();
    });
});

describe('Auth Portal login: when the portal cannot be reached', () => {
    it('says so without blaming the password (reason prop)', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));
        inertiaState.formErrors = {
            email: 'Sign-in is temporarily unavailable. Please try again shortly.',
        };

        const view = await render(<Login reason="unavailable" />);
        const alert = view.byTestId('login-portal-unavailable');

        expect(alert?.getAttribute('role')).toBe('alert');
        expect(alert?.textContent).toContain('Auth Portal unreachable');
        expect(alert?.textContent).toContain('Your password was not rejected');
        // The backend text is not repeated under the field.
        expect(view.text()).not.toContain('temporarily unavailable');
        expect(view.byTestId('login-no-chat-access')).toBeNull();
    });

    it('also recognises the validation error key `unavailable`', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));
        inertiaState.formErrors = { unavailable: 'unavailable' };

        const view = await render(<Login />);

        expect(view.byTestId('login-portal-unavailable')).not.toBeNull();
    });

    it('is only for the Auth Portal: local sign-in keeps the starter-kit behaviour', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));
        inertiaState.formErrors = { email: 'These credentials do not match.' };

        const view = await render(<Login reason="unavailable" />);

        expect(view.byTestId('login-portal-unavailable')).toBeNull();
        expect(view.text()).toContain('These credentials do not match.');
    });

    it('leaves a wrong password as an ordinary inline error', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));
        inertiaState.formErrors = { email: 'These credentials do not match.' };

        const view = await render(<Login />);

        expect(view.byTestId('login-portal-unavailable')).toBeNull();
        expect(view.byTestId('login-no-chat-access')).toBeNull();
        expect(view.text()).toContain('These credentials do not match.');
    });

    it('prefers the no-access notice when both signals are present', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));
        inertiaState.formErrors = { unavailable: 'x', no_chat_access: 'y' };

        const view = await render(<Login />);

        expect(view.byTestId('login-no-chat-access')).not.toBeNull();
        expect(view.byTestId('login-portal-unavailable')).toBeNull();
    });
});

describe('Auth Portal login: no chat access', () => {
    it('points at the portal roles', async () => {
        resetInertiaMock(guest('pizzasys', portalCapabilities));

        const view = await render(<Login reason="no_chat_access" />);
        const alert = view.byTestId('login-no-chat-access');

        expect(alert?.textContent).toContain('No chat access');
        expect(alert?.textContent).toContain(
            'Access follows your Auth Portal roles',
        );
    });

    it('keeps the plain wording for local sign-in', async () => {
        resetInertiaMock(guest('fortify', fortifyCapabilities));

        const view = await render(<Login reason="no_chat_access" />);

        expect(
            view.byTestId('login-no-chat-access')?.textContent,
        ).not.toContain('Auth Portal');
    });
});
