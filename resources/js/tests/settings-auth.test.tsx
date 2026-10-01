import '@/tests/polyfills';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { ActiveEnvironmentCard } from '@/components/settings/auth/active-environment-card';
import { EnvironmentCard } from '@/components/settings/auth/environment-card';
import SettingsLayout from '@/layouts/settings/layout';
import AuthSettings from '@/pages/settings/auth';
import {
    completeVisit,
    lastVisit,
    resetInertiaMock,
    routerMock,
} from '@/tests/inertia-mock';
import { click, flush, render, typeInto } from '@/tests/render';
import type {
    AuthSettingsData,
    PizzasysEnvironmentData,
    SettingsAuthProps,
} from '@/types';

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

const toast = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
}));

vi.mock('sonner', () => ({ toast }));

const NOW = '2026-09-30T20:00:00Z';

const env = (
    key: 'production' | 'testing',
    overrides: Partial<PizzasysEnvironmentData> = {},
): PizzasysEnvironmentData => ({
    key,
    label: key === 'production' ? 'Production' : 'Testing',
    configured: true,
    base_url: `https://${key}.example.com`,
    service_name: 'pne-chat',
    has_service_token: true,
    nats_url: null,
    has_nats_token: false,
    verify_tls: true,
    last_check_at: '2026-09-30T19:55:00Z',
    last_check_status: 'ok',
    last_check_message: null,
    ...overrides,
});

const settingsData = (
    overrides: Partial<AuthSettingsData> = {},
): AuthSettingsData => ({
    mode: 'pizzasys',
    active_env: 'production',
    environments: [env('production'), env('testing')],
    roles: {
        admin_permission: 'chat.admin',
        agent_permission: 'chat.agent',
        super_roles: ['super-admin'],
    },
    health: {
        portal: 'ok',
        circuit_open: false,
        service_credential_rejected: false,
        last_verify_at: '2026-09-30T19:58:00Z',
        nats: {
            enabled: true,
            connected: true,
            last_event_at: '2026-09-30T19:50:00Z',
        },
    },
    ...overrides,
});

const capabilities = {
    canRegister: false,
    canResetPassword: false,
    canManage2fa: false,
    profileEditable: false,
    portalUrl: 'https://production.example.com',
};

const asUser = (
    flags: { is_admin: boolean; is_agent: boolean },
    mode: 'fortify' | 'pizzasys' = 'pizzasys',
) =>
    resetInertiaMock({
        auth: {
            user: {
                id: 1,
                name: 'Mina Haddad',
                email: 'mina@example.com',
                avatar: null,
                auth_source: mode === 'pizzasys' ? 'pizzasys' : 'local',
                ...flags,
            },
            mode,
            capabilities,
        },
    });

const admin = (mode: 'fortify' | 'pizzasys' = 'pizzasys') =>
    asUser({ is_admin: true, is_agent: false }, mode);

const page = (authSettings: AuthSettingsData): SettingsAuthProps => ({
    authSettings,
});

const input = (view: { container: HTMLElement }, id: string) =>
    view.container.querySelector<HTMLInputElement>(`#${id}`);

/** Portals (the dialog) render outside the test container. */
const inDocument = (id: string) =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const stubFetch = (
    handler: (
        url: string,
        body: Record<string, unknown>,
    ) => { status?: number; body: unknown },
) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const body =
                typeof init?.body === 'string'
                    ? (JSON.parse(init.body) as Record<string, unknown>)
                    : {};

            calls.push({ url, body });

            const reply = handler(url, body);

            return new Response(JSON.stringify(reply.body), {
                status: reply.status ?? 200,
            });
        }),
    );

    return calls;
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    toast.success.mockClear();
    toast.error.mockClear();
    admin();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Settings > Auth by mode', () => {
    it('explains that sign-in is managed by this app in local mode, with nothing to edit', async () => {
        admin('fortify');

        const view = await render(
            <AuthSettings
                {...page(
                    settingsData({
                        mode: 'fortify',
                        environments: [],
                    }),
                )}
            />,
        );

        expect(view.byTestId('settings-auth')?.dataset.mode).toBe('fortify');
        expect(view.byTestId('settings-auth-managed')?.textContent).toContain(
            'Managed by this app',
        );
        expect(view.byTestId('settings-auth-mode')?.textContent).toBe(
            'Starter kit auth',
        );
        // No portal controls at all, and no inputs to type a secret into.
        for (const id of [
            'settings-auth-health',
            'settings-auth-switch',
            'settings-auth-env-production',
            'settings-auth-roles',
        ]) {
            expect(view.byTestId(id)).toBeNull();
        }
        expect(view.container.querySelector('input')).toBeNull();
        expect(view.container.querySelector('form')).toBeNull();
    });

    it('shows health, both environments, the switcher and the role mapping for the Auth Portal', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        expect(view.byTestId('settings-auth')?.dataset.mode).toBe('pizzasys');
        expect(view.byTestId('settings-auth-mode')?.textContent).toBe(
            'Auth Portal (pizzasys)',
        );
        expect(view.byTestId('settings-auth-managed')).toBeNull();
        expect(view.byTestId('settings-auth-health')).not.toBeNull();
        expect(view.byTestId('settings-auth-switch')).not.toBeNull();
        expect(view.byTestId('settings-auth-env-production')).not.toBeNull();
        expect(view.byTestId('settings-auth-env-testing')).not.toBeNull();
        expect(view.byTestId('settings-auth-roles')).not.toBeNull();
        // Production first, and only the active one carries the badge.
        expect(
            Array.from(
                view.container.querySelectorAll<HTMLElement>(
                    '[role="region"][data-testid^="settings-auth-env-"]',
                ),
            ).map((card) => card.dataset.testid),
        ).toEqual([
            'settings-auth-env-production',
            'settings-auth-env-testing',
        ]);
        expect(
            view.byTestId('settings-auth-env-production-active'),
        ).not.toBeNull();
        expect(view.byTestId('settings-auth-env-testing-active')).toBeNull();
    });

    it('refuses to render admin controls for an agent', async () => {
        asUser({ is_admin: false, is_agent: true });

        const view = await render(<AuthSettings {...page(settingsData())} />);

        expect(view.byTestId('settings-auth-forbidden')).not.toBeNull();
        expect(view.byTestId('settings-auth-health')).toBeNull();
        expect(view.byTestId('settings-auth-env-production')).toBeNull();
        expect(view.container.querySelector('input')).toBeNull();
    });
});

describe('Settings layout item', () => {
    const items = (view: { container: HTMLElement }) =>
        Array.from(view.container.querySelectorAll('nav a')).map((a) => ({
            href: a.getAttribute('href'),
            text: a.textContent,
        }));

    it('adds the Auth portal item for admins in Auth Portal mode', async () => {
        const view = await render(
            <SettingsLayout>
                <span />
            </SettingsLayout>,
        );

        expect(items(view)).toContainEqual({
            href: '/settings/auth',
            text: 'Auth portal',
        });
    });

    it('calls it the sign-in method in local mode', async () => {
        admin('fortify');

        const view = await render(
            <SettingsLayout>
                <span />
            </SettingsLayout>,
        );

        expect(items(view)).toContainEqual({
            href: '/settings/auth',
            text: 'Sign-in method',
        });
    });

    it('hides it from agents', async () => {
        asUser({ is_admin: false, is_agent: true });

        const view = await render(
            <SettingsLayout>
                <span />
            </SettingsLayout>,
        );

        expect(items(view).some((item) => item.href === '/settings/auth')).toBe(
            false,
        );
        // The ordinary settings pages are still there.
        expect(items(view).map((item) => item.text)).toEqual(
            expect.arrayContaining(['Profile', 'Security', 'Appearance']),
        );
    });

    it('hides it from a user without any chat role', async () => {
        asUser({ is_admin: false, is_agent: false });

        const view = await render(
            <SettingsLayout>
                <span />
            </SettingsLayout>,
        );

        expect(items(view).some((item) => item.href === '/settings/auth')).toBe(
            false,
        );
    });
});

describe('health card', () => {
    it('shows the portal status, circuit, last verify and NATS', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        expect(
            view.byTestId('settings-auth-health-status')?.dataset.status,
        ).toBe('ok');
        expect(view.byTestId('settings-auth-health-status')?.textContent).toBe(
            'Healthy',
        );
        expect(
            view.byTestId('settings-auth-health-circuit')?.textContent,
        ).toContain('Closed');
        expect(
            view.byTestId('settings-auth-health-last-verify')?.textContent,
        ).toBe('2 minutes ago');
        expect(
            view
                .byTestId('settings-auth-health-last-verify')
                ?.querySelector('time')
                ?.getAttribute('datetime'),
        ).toBe('2026-09-30T19:58:00Z');
        expect(view.byTestId('settings-auth-health-nats')?.dataset.state).toBe(
            'connected',
        );
        expect(
            view.byTestId('settings-auth-health-nats')?.textContent,
        ).toContain('10 minutes ago');
    });

    it('warns that new sign-ins are blocked when the service credential was rejected', async () => {
        const view = await render(
            <AuthSettings
                {...page(
                    settingsData({
                        health: {
                            ...settingsData().health,
                            portal: 'degraded',
                            service_credential_rejected: true,
                        },
                    }),
                )}
            />,
        );

        expect(
            view.byTestId('settings-auth-health-credential-rejected')
                ?.textContent,
        ).toContain('rejected');
    });

    it('shows no warning when the service credential is fine', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        expect(
            view.byTestId('settings-auth-health-credential-rejected'),
        ).toBeNull();
    });

    it('says so when the portal is degraded, the circuit is open and NATS is not enabled', async () => {
        const view = await render(
            <AuthSettings
                {...page(
                    settingsData({
                        health: {
                            portal: 'degraded',
                            circuit_open: true,
                            service_credential_rejected: false,
                            last_verify_at: null,
                            nats: {
                                enabled: false,
                                connected: null,
                                last_event_at: null,
                            },
                        },
                    }),
                )}
            />,
        );

        expect(view.byTestId('settings-auth-health-status')?.textContent).toBe(
            'Degraded',
        );
        expect(
            view.byTestId('settings-auth-health-circuit')?.textContent,
        ).toContain('Open');
        expect(
            view.byTestId('settings-auth-health-last-verify')?.textContent,
        ).toBe('Never');
        expect(view.byTestId('settings-auth-health-nats')?.dataset.state).toBe(
            'disabled',
        );
        // Without NATS there is no "last event" line.
        expect(
            view.byTestId('settings-auth-health-nats')?.textContent,
        ).not.toContain('Last event');
    });

    it('covers the down, unknown and disconnected states', async () => {
        const view = await render(
            <AuthSettings
                {...page(
                    settingsData({
                        health: {
                            portal: 'down',
                            circuit_open: false,
                            service_credential_rejected: false,
                            last_verify_at: null,
                            nats: {
                                enabled: true,
                                connected: false,
                                last_event_at: null,
                            },
                        },
                    }),
                )}
            />,
        );

        expect(view.byTestId('settings-auth-health-status')?.textContent).toBe(
            'Down',
        );
        expect(view.byTestId('settings-auth-health-nats')?.dataset.state).toBe(
            'disconnected',
        );
    });

    it('refreshes only the settings prop on demand', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        await click(view.byTestId('settings-auth-health-refresh'));

        expect(routerMock.reload).toHaveBeenCalledWith(
            expect.objectContaining({ only: ['authSettings'] }),
        );
    });
});

describe('environment card', () => {
    it('never prefills a secret and only indicates a stored one', async () => {
        const view = await render(
            <EnvironmentCard
                env={env('production', {
                    has_nats_token: true,
                    nats_url: 'nats://nats.example.com:4222',
                })}
                isActive
            />,
        );

        expect(
            input(view, 'settings-auth-env-production-service-token')?.value,
        ).toBe('');
        expect(
            input(view, 'settings-auth-env-production-nats-token')?.value,
        ).toBe('');
        expect(
            input(view, 'settings-auth-env-production-service-token')?.type,
        ).toBe('password');
        expect(
            view.byTestId('settings-auth-env-production-service-token-saved'),
        ).not.toBeNull();
        expect(
            view.byTestId('settings-auth-env-production-nats-token-saved'),
        ).not.toBeNull();
        // Non-secret fields are filled from the server.
        expect(
            input(view, 'settings-auth-env-production-base-url')?.value,
        ).toBe('https://production.example.com');
        expect(
            input(view, 'settings-auth-env-production-nats-url')?.value,
        ).toBe('nats://nats.example.com:4222');
        expect(input(view, 'settings-auth-env-production-label')?.value).toBe(
            'Production',
        );
    });

    it('has nothing to save until something changes', async () => {
        const view = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );

        expect(
            view
                .byTestId('settings-auth-env-production-save')
                ?.hasAttribute('disabled'),
        ).toBe(true);

        await typeInto(
            input(view, 'settings-auth-env-production-base-url'),
            'https://new.example.com',
        );

        expect(
            view
                .byTestId('settings-auth-env-production-save')
                ?.hasAttribute('disabled'),
        ).toBe(false);
    });

    it('saves with the secrets omitted when they are unchanged', async () => {
        const view = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );

        await typeInto(
            input(view, 'settings-auth-env-production-base-url'),
            'https://new.example.com',
        );
        await click(view.byTestId('settings-auth-env-production-save'));

        expect(routerMock.put).toHaveBeenCalledTimes(1);

        const sent = lastVisit('put');

        expect(sent.url).toBe('/settings/auth/environments/production');
        expect(sent.data).toEqual({
            label: 'Production',
            base_url: 'https://new.example.com',
            service_name: 'pne-chat',
            verify_tls: true,
            nats_url: null,
        });
        expect(sent.data).not.toHaveProperty('service_token');
        expect(sent.data).not.toHaveProperty('nats_token');
    });

    it('sends a rotated token once, empties the input afterwards and confirms with a toast', async () => {
        const view = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );

        await typeInto(
            input(view, 'settings-auth-env-production-service-token'),
            'rotated-secret',
        );
        await click(view.byTestId('settings-auth-env-production-save'));

        expect(lastVisit('put').data.service_token).toBe('rotated-secret');

        await completeVisit(lastVisit('put'));

        expect(
            input(view, 'settings-auth-env-production-service-token')?.value,
        ).toBe('');
        expect(toast.success).toHaveBeenCalledWith(
            'Production settings saved.',
        );
        expect(view.container.innerHTML).not.toContain('rotated-secret');
    });

    it('forgets the stored NATS token only when asked to', async () => {
        const view = await render(
            <EnvironmentCard
                env={env('production', { has_nats_token: true })}
                isActive
            />,
        );

        await click(
            view.byTestId('settings-auth-env-production-nats-token-clear'),
        );
        await click(view.byTestId('settings-auth-env-production-save'));

        expect(lastVisit('put').data.nats_token).toBeNull();
    });

    it('validates before it sends and shows server errors inline', async () => {
        const view = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );

        await typeInto(
            input(view, 'settings-auth-env-production-base-url'),
            'http://insecure.example.com',
        );
        await click(view.byTestId('settings-auth-env-production-save'));

        expect(routerMock.put).not.toHaveBeenCalled();
        expect(view.text()).toContain('Use https.');
        expect(
            input(view, 'settings-auth-env-production-base-url')?.getAttribute(
                'aria-invalid',
            ),
        ).toBe('true');

        await typeInto(
            input(view, 'settings-auth-env-production-base-url'),
            'https://fine.example.com',
        );
        await click(view.byTestId('settings-auth-env-production-save'));
        await completeVisit(lastVisit('put'), {
            errors: { service_name: 'That service name is not registered.' },
        });

        expect(view.text()).toContain('That service name is not registered.');
    });

    it('tests the saved values only, and says to save first while there are unsaved edits', async () => {
        const calls = stubFetch(() => ({
            body: {
                ok: true,
                checks: [
                    { key: 'reachable', label: 'Reachable', ok: true },
                    {
                        key: 'service_credential',
                        label: 'Credential',
                        ok: true,
                    },
                ],
            },
        }));
        const view = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );
        const test = () => view.byTestId('settings-auth-env-production-test');

        expect(test()?.hasAttribute('disabled')).toBe(false);

        await typeInto(
            input(view, 'settings-auth-env-production-service-name'),
            'other-name',
        );

        expect(test()?.hasAttribute('disabled')).toBe(true);
        expect(
            view.byTestId('settings-auth-env-production-dirty-hint')
                ?.textContent,
        ).toContain('Save your changes to test them');

        await typeInto(
            input(view, 'settings-auth-env-production-service-name'),
            'pne-chat',
        );
        await click(test());
        await flush();

        expect(calls).toEqual([
            { url: '/settings/auth/environments/production/test', body: {} },
        ]);
        expect(
            view.byTestId('settings-auth-env-production-result')?.dataset.state,
        ).toBe('done');
        expect(routerMock.reload).toHaveBeenCalledWith(
            expect.objectContaining({ only: ['authSettings'] }),
        );
    });

    it('shows how to fix a failed test', async () => {
        stubFetch(() => ({
            body: {
                ok: false,
                checks: [
                    {
                        key: 'reachable',
                        label: 'Reachable',
                        ok: false,
                        message: 'cURL error 6: Could not resolve host',
                    },
                ],
            },
        }));

        const view = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );

        await click(view.byTestId('settings-auth-env-production-test'));
        await flush();

        expect(
            view.byTestId('settings-auth-env-production-result-reachable')
                ?.dataset.ok,
        ).toBe('false');
        expect(view.text()).toContain('Could not resolve host');
        expect(view.text()).toContain(
            'Check the portal address, DNS and firewall',
        );
    });

    it('does not offer a test for an environment that is not set up', async () => {
        const view = await render(
            <EnvironmentCard
                env={env('testing', {
                    configured: false,
                    base_url: null,
                    service_name: null,
                    has_service_token: false,
                    last_check_at: null,
                    last_check_status: null,
                })}
                isActive={false}
            />,
        );

        expect(
            view.byTestId('settings-auth-env-testing-unconfigured')
                ?.textContent,
        ).toBe('Not set up');
        expect(
            view
                .byTestId('settings-auth-env-testing-test')
                ?.hasAttribute('disabled'),
        ).toBe(true);
        expect(
            view.byTestId('settings-auth-env-testing-last-check'),
        ).toBeNull();
        // A first save needs the token, since none is stored.
        await typeInto(
            input(view, 'settings-auth-env-testing-base-url'),
            'https://testing.example.com',
        );
        await typeInto(
            input(view, 'settings-auth-env-testing-service-name'),
            'pne-chat',
        );
        await click(view.byTestId('settings-auth-env-testing-save'));

        expect(routerMock.put).not.toHaveBeenCalled();
        expect(view.text()).toContain(
            'Paste the service token for this environment.',
        );
    });

    it('reports the last stored test, passed or failed', async () => {
        const passed = await render(
            <EnvironmentCard env={env('production')} isActive />,
        );

        expect(
            passed.byTestId('settings-auth-env-production-last-check')
                ?.textContent,
        ).toContain('Last test passed 5 minutes ago');

        const failed = await render(
            <EnvironmentCard
                env={env('testing', {
                    last_check_status: 'failed',
                    last_check_message: 'HTTP 401: Invalid service token.',
                })}
                isActive={false}
            />,
        );

        const line = failed.byTestId('settings-auth-env-testing-last-check');

        expect(line?.textContent).toContain('Last test failed 5 minutes ago');
        expect(line?.textContent).toContain('HTTP 401: Invalid service token.');
        expect(line?.dataset.status).toBe('failed');

        const never = await render(
            <EnvironmentCard
                env={env('testing', {
                    last_check_at: null,
                    last_check_status: null,
                })}
                isActive={false}
            />,
        );

        expect(
            never.byTestId('settings-auth-env-testing-last-check')?.textContent,
        ).toContain('Not tested yet.');
    });
});

describe('active environment switcher', () => {
    const credentials = {
        email: 'admin@testing.example.com',
        password: 'pw-123',
    };

    const open = async (view: Awaited<ReturnType<typeof render>>) => {
        await click(view.byTestId('settings-auth-switch-open'));
    };

    const fill = async () => {
        await typeInto(
            inDocument('settings-auth-switch-email') as HTMLInputElement,
            credentials.email,
        );
        await typeInto(
            inDocument('settings-auth-switch-password') as HTMLInputElement,
            credentials.password,
        );
    };

    const submitButton = () =>
        inDocument('settings-auth-switch-submit') as HTMLButtonElement;

    it('shows the active environment and offers the other one when it is usable', async () => {
        const view = await render(
            <ActiveEnvironmentCard settings={settingsData()} />,
        );

        expect(view.byTestId('settings-auth-switch-current')?.textContent).toBe(
            'Production',
        );
        expect(
            view.byTestId('settings-auth-switch-open')?.textContent,
        ).toContain('Switch to Testing');
        expect(
            view
                .byTestId('settings-auth-switch-open')
                ?.hasAttribute('disabled'),
        ).toBe(false);
    });

    it('offers the way back when Testing is the active environment', async () => {
        const view = await render(
            <ActiveEnvironmentCard
                settings={settingsData({ active_env: 'testing' })}
            />,
        );

        expect(
            view.byTestId('settings-auth-switch-open')?.textContent,
        ).toContain('Switch to Production');
    });

    it('cannot switch to an environment that is not set up, and says why', async () => {
        const view = await render(
            <ActiveEnvironmentCard
                settings={settingsData({
                    environments: [
                        env('production'),
                        env('testing', {
                            configured: false,
                            has_service_token: false,
                        }),
                    ],
                })}
            />,
        );

        expect(
            view
                .byTestId('settings-auth-switch-open')
                ?.hasAttribute('disabled'),
        ).toBe(true);
        expect(
            view.byTestId('settings-auth-switch-unavailable')?.textContent,
        ).toContain('Set up the other environment first');
    });

    it('spells out the consequences and refuses to submit without credentials and a confirmation', async () => {
        const view = await render(
            <ActiveEnvironmentCard settings={settingsData()} />,
        );

        await open(view);

        const dialog = inDocument('settings-auth-switch-dialog');

        expect(dialog?.getAttribute('role')).toBe('dialog');
        expect(dialog?.textContent).toContain('Switch to Testing?');
        expect(dialog?.textContent).toContain(
            'Everyone is signed out, including you.',
        );
        expect(dialog?.textContent).toContain('audit log');
        expect(submitButton().disabled).toBe(true);

        await typeInto(
            inDocument('settings-auth-switch-email') as HTMLInputElement,
            credentials.email,
        );
        expect(submitButton().disabled).toBe(true);

        await typeInto(
            inDocument('settings-auth-switch-password') as HTMLInputElement,
            credentials.password,
        );
        // Credentials alone are not enough: the user must acknowledge the sign-out.
        expect(submitButton().disabled).toBe(true);

        await click(inDocument('settings-auth-switch-ack'));
        expect(submitButton().disabled).toBe(false);
    });

    it('posts the target environment with the admin credentials and follows the redirect', async () => {
        const calls = stubFetch(() => ({
            body: { ok: true, redirect: '/login' },
        }));
        const navigate = vi.fn();
        const view = await render(
            <ActiveEnvironmentCard
                settings={settingsData()}
                navigate={navigate}
            />,
        );

        await open(view);
        await fill();
        await click(inDocument('settings-auth-switch-ack'));
        await click(submitButton());
        await flush();

        expect(calls).toEqual([
            {
                url: '/settings/auth/active-environment',
                body: {
                    env: 'testing',
                    email: credentials.email,
                    password: credentials.password,
                    confirm: true,
                },
            },
        ]);
        expect(navigate).toHaveBeenCalledWith('/login');
        expect(
            inDocument('settings-auth-switch-status')?.textContent,
        ).toContain('Taking you to sign in');
        // Nothing can be changed or dismissed once the switch happened.
        expect(
            (inDocument('settings-auth-switch-cancel') as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it('keeps the dialog open with the reason when the switch is refused', async () => {
        stubFetch(() => ({
            status: 422,
            body: {
                ok: false,
                message: 'That account is not an admin on Testing.',
            },
        }));

        const navigate = vi.fn();
        const view = await render(
            <ActiveEnvironmentCard
                settings={settingsData()}
                navigate={navigate}
            />,
        );

        await open(view);
        await fill();
        await click(inDocument('settings-auth-switch-ack'));
        await click(submitButton());
        await flush();

        const problem = inDocument('settings-auth-switch-problem');

        expect(navigate).not.toHaveBeenCalled();
        expect(problem?.getAttribute('role')).toBe('alert');
        expect(problem?.textContent).toBe(
            'That account is not an admin on Testing.',
        );
        expect(inDocument('settings-auth-switch-dialog')).not.toBeNull();
        // The password is cleared and focus goes back to it for another try.
        const password = inDocument(
            'settings-auth-switch-password',
        ) as HTMLInputElement;

        expect(password.value).toBe('');
        expect(document.activeElement).toBe(password);
        expect(submitButton().disabled).toBe(true);
    });

    it('resets the form when it is cancelled', async () => {
        const view = await render(
            <ActiveEnvironmentCard settings={settingsData()} />,
        );

        await open(view);
        await fill();
        await click(inDocument('settings-auth-switch-cancel'));

        expect(inDocument('settings-auth-switch-dialog')).toBeNull();

        await open(view);

        expect(
            (inDocument('settings-auth-switch-email') as HTMLInputElement)
                .value,
        ).toBe('');
    });

    it('says plainly when the request itself failed', async () => {
        stubFetch(() => ({ status: 429, body: {} }));

        const view = await render(
            <ActiveEnvironmentCard
                settings={settingsData()}
                navigate={vi.fn()}
            />,
        );

        await open(view);
        await fill();
        await click(inDocument('settings-auth-switch-ack'));
        await click(submitButton());
        await flush();

        expect(
            inDocument('settings-auth-switch-problem')?.textContent,
        ).toContain('Too many attempts');
    });
});

describe('roles card', () => {
    it('starts clean with the saved mapping', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        expect(input(view, 'settings-auth-roles-admin-permission')?.value).toBe(
            'chat.admin',
        );
        expect(input(view, 'settings-auth-roles-agent-permission')?.value).toBe(
            'chat.agent',
        );
        expect(
            view
                .allByTestId('settings-auth-roles-super-roles-tag')
                .map((tag) => tag.textContent),
        ).toEqual(['super-admin']);
        expect(
            view.byTestId('settings-auth-roles-save')?.hasAttribute('disabled'),
        ).toBe(true);
    });

    it('saves the mapping with PUT /settings/auth/roles', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        await typeInto(
            input(view, 'settings-auth-roles-agent-permission'),
            'chat.support',
        );
        await click(view.byTestId('settings-auth-roles-save'));

        const sent = lastVisit('put');

        expect(sent.url).toBe('/settings/auth/roles');
        expect(sent.data).toEqual({
            admin_permission: 'chat.admin',
            agent_permission: 'chat.support',
            super_roles: ['super-admin'],
        });

        await completeVisit(sent);

        expect(toast.success).toHaveBeenCalledWith('Role mapping saved.');
    });

    it('refuses the same name for both roles and shows server errors', async () => {
        const view = await render(<AuthSettings {...page(settingsData())} />);

        await typeInto(
            input(view, 'settings-auth-roles-agent-permission'),
            'chat.admin',
        );
        await click(view.byTestId('settings-auth-roles-save'));

        expect(routerMock.put).not.toHaveBeenCalled();
        expect(view.text()).toContain('every agent would be an admin');

        await typeInto(
            input(view, 'settings-auth-roles-agent-permission'),
            'chat.agent2',
        );
        await click(view.byTestId('settings-auth-roles-save'));
        await completeVisit(lastVisit('put'), {
            errors: { super_roles: 'The super roles must be an array.' },
        });

        expect(view.text()).toContain('The super roles must be an array.');
    });
});
