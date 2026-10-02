import '@/tests/polyfills';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import SettingsLayout from '@/layouts/settings/layout';
import Profile from '@/pages/settings/profile';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { render } from '@/tests/render';
import type { AuthCapabilities } from '@/types';

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

const portal: AuthCapabilities = {
    canRegister: false,
    canResetPassword: false,
    canManage2fa: false,
    profileEditable: false,
    portalUrl: 'https://auth.example.test/app',
};

const local: AuthCapabilities = {
    canRegister: false,
    canResetPassword: true,
    canManage2fa: true,
    profileEditable: true,
    portalUrl: null,
};

const signedIn = (
    mode: 'fortify' | 'pizzasys',
    capabilities: AuthCapabilities,
) =>
    resetInertiaMock({
        auth: {
            user: {
                id: 1,
                name: 'Mina Haddad',
                email: 'mina@example.com',
                avatar: null,
                auth_source: mode === 'pizzasys' ? 'pizzasys' : 'local',
                is_admin: false,
                is_agent: true,
            },
            mode,
            capabilities,
        },
    });

const navTexts = (view: { container: HTMLElement }) =>
    Array.from(view.container.querySelectorAll('nav a')).map(
        (link) => link.textContent,
    );

beforeEach(() => signedIn('fortify', local));

describe('Settings in Auth Portal mode', () => {
    it('leaves out the Security page, which the portal owns (it answers 404)', async () => {
        signedIn('pizzasys', portal);

        const view = await render(
            <SettingsLayout>
                <span />
            </SettingsLayout>,
        );

        // The test user is an agent, so the support-categories entry follows the account pages.
        expect(navTexts(view)).toEqual([
            'Profile',
            'Appearance',
            'Notifications',
            'Support categories',
        ]);
    });

    it('keeps the Security page in local mode', async () => {
        const view = await render(
            <SettingsLayout>
                <span />
            </SettingsLayout>,
        );

        expect(navTexts(view)).toEqual([
            'Profile',
            'Security',
            'Appearance',
            'Notifications',
            'Support categories',
        ]);
    });

    it('shows the profile read-only, with a link to the portal and nothing to save or delete', async () => {
        signedIn('pizzasys', portal);

        const view = await render(
            <Profile mustVerifyEmail={false} status={undefined} />,
        );

        expect(view.byTestId('profile-managed')).not.toBeNull();
        expect(view.text()).toContain('Managed in the Auth Portal');

        const name = view.container.querySelector<HTMLInputElement>('#name');
        const email = view.container.querySelector<HTMLInputElement>('#email');

        expect(name?.value).toBe('Mina Haddad');
        expect(name?.readOnly).toBe(true);
        expect(email?.value).toBe('mina@example.com');
        expect(email?.readOnly).toBe(true);

        // No form to submit (the endpoints answer 404) and no account deletion.
        expect(view.container.querySelector('form')).toBeNull();
        expect(
            view.container.querySelector('[data-test="update-profile-button"]'),
        ).toBeNull();
        expect(view.text()).not.toContain('Delete account');

        expect(
            view.container.querySelector('a[href^="https://auth.example.test"]')
                ?.textContent,
        ).toBe('Open the Auth Portal');
    });

    it('still edits the profile in local mode', async () => {
        const view = await render(
            <Profile mustVerifyEmail={false} status={undefined} />,
        );

        expect(view.byTestId('profile-managed')).toBeNull();
        expect(
            view.container.querySelector('[data-test="update-profile-button"]'),
        ).not.toBeNull();
        expect(view.text()).toContain('Delete account');
    });
});
