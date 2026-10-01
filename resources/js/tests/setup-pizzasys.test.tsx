import '@/tests/polyfills';
import { act, useState } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { StepPizzasys } from '@/components/setup/step-pizzasys';
import { StepPortalAdmin } from '@/components/setup/step-portal-admin';
import { createPortalClient } from '@/lib/pizzasys-http';
import Setup from '@/pages/setup/index';
import {
    completeVisit,
    lastVisit,
    resetInertiaMock,
    routerMock,
} from '@/tests/inertia-mock';
import { click, flush, render, typeInto } from '@/tests/render';
import type {
    PizzasysEnvironmentData,
    PizzasysSetupData,
    SetupProps,
    SetupState,
    SetupStepKey,
} from '@/types';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const LABELS: Record<SetupStepKey, string> = {
    welcome: 'Welcome',
    mode: 'Mode',
    admin: 'Admin',
    pizzasys: 'Auth Portal',
    'portal-admin': 'Portal admin',
    basics: 'Basics',
    run: 'Run',
    done: 'Done',
};

/** The server's step list for mode 2 (the admin step is skipped). */
const PORTAL_ORDER: SetupStepKey[] = [
    'welcome',
    'mode',
    'pizzasys',
    'portal-admin',
    'basics',
    'run',
    'done',
];

const env = (
    key: 'production' | 'testing',
    overrides: Partial<PizzasysEnvironmentData> = {},
): PizzasysEnvironmentData => ({
    key,
    label: key === 'production' ? 'Production' : 'Testing',
    configured: false,
    base_url: null,
    service_name: null,
    has_service_token: false,
    nats_url: null,
    has_nats_token: false,
    verify_tls: true,
    last_check_at: null,
    last_check_status: null,
    last_check_message: null,
    ...overrides,
});

const pizzasysData = (
    overrides: Partial<PizzasysSetupData> = {},
): PizzasysSetupData => ({
    environments: { production: env('production'), testing: env('testing') },
    active_env: 'production',
    roles: {
        admin_permission: 'chat.admin',
        agent_permission: 'chat.agent',
        super_roles: ['super-admin'],
    },
    tested: { production: false, testing: false },
    portal_admin: null,
    ...overrides,
});

function portalSetup(
    step: SetupStepKey,
    pizzasys: PizzasysSetupData | null = pizzasysData(),
    overrides: Partial<SetupState> = {},
): SetupProps {
    const current = PORTAL_ORDER.indexOf(step);

    return {
        setup: {
            step,
            steps: PORTAL_ORDER.map((key, index) => ({
                key,
                label: LABELS[key],
                status:
                    index < current
                        ? 'done'
                        : index === current
                          ? 'current'
                          : 'pending',
            })),
            needsToken: false,
            tokenVerified: false,
            mode: 'pizzasys',
            pizzasysAvailable: true,
            environment: { ok: true, checks: [] },
            defaults: {
                app_name: 'PNE Chat',
                app_url: 'https://chat.example.com',
                locale: 'en',
                timezone: 'Europe/Berlin',
                idle_timeout_minutes: 120,
            },
            admin: null,
            run: [],
            pizzasys,
            ...overrides,
        },
    };
}

/** Lets a test play "the server answered with new props" by swapping the page props. */
let setPageProps: (next: SetupProps) => void = () => {};

function Harness({ initial }: { initial: SetupProps }) {
    const [props, setProps] = useState(initial);

    setPageProps = setProps;

    return <Setup {...props} />;
}

type FetchHandler = (
    url: string,
    body: Record<string, unknown>,
) => { status?: number; body: unknown } | Promise<never>;

function stubFetch(handler: FetchHandler) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const body =
                typeof init?.body === 'string'
                    ? (JSON.parse(init.body) as Record<string, unknown>)
                    : {};

            calls.push({ url, body });

            const reply = await handler(url, body);

            return new Response(JSON.stringify(reply.body), {
                status: reply.status ?? 200,
            });
        }),
    );

    return calls;
}

const passingResult = {
    ok: true,
    checks: [
        {
            key: 'reachable',
            label: 'Portal reachable',
            ok: true,
            message: 'HTTP 200',
        },
        { key: 'service_credential', label: 'Service credential', ok: true },
        { key: 'latency', label: 'Latency', ok: true, message: '212 ms' },
    ],
};

const input = (view: { container: HTMLElement }, id: string) =>
    view.container.querySelector<HTMLInputElement>(`#${id}`);

async function fillProduction(view: { container: HTMLElement }) {
    await typeInto(
        input(view, 'setup-env-production-base-url'),
        'https://auth.example.com',
    );
    await typeInto(
        input(view, 'setup-env-production-service-token'),
        'service-secret',
    );
}

beforeEach(() => resetInertiaMock());

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the Auth Portal mode card', () => {
    it('is the step the server asks for after the mode choice', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('pizzasys');
        expect(view.byTestId('setup-step-pizzasys')).not.toBeNull();
        // The stepper lists the portal steps, with their own translated labels.
        expect(
            view.byTestId('setup-stepper-item-portal-admin')?.textContent,
        ).toContain('Portal admin');
        expect(view.byTestId('setup-stepper-item-admin')).toBeNull();
        expect(view.byTestId('setup-stepper-compact')?.textContent).toContain(
            'Step 3 of 7',
        );
    });
});

describe('pizzasys step', () => {
    it('shows Production, a collapsed optional Testing, roles with their defaults and the active choice', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        expect(view.byTestId('setup-env-production')).not.toBeNull();
        expect(input(view, 'setup-env-production-base-url')?.value).toBe('');
        // A fresh Production suggests the service name pizzasys admins register this app under.
        expect(input(view, 'setup-env-production-service-name')?.value).toBe(
            'pne-chat',
        );
        expect(input(view, 'setup-env-production-nats-url')).not.toBeNull();
        expect(
            view
                .byTestId('setup-env-production-verify-tls')
                ?.getAttribute('aria-checked'),
        ).toBe('true');

        // Testing is optional and collapsed until asked for.
        expect(view.byTestId('setup-env-testing-toggle')).not.toBeNull();
        expect(input(view, 'setup-env-testing-base-url')).toBeNull();

        expect(input(view, 'setup-roles-admin-permission')?.value).toBe(
            'chat.admin',
        );
        expect(input(view, 'setup-roles-agent-permission')?.value).toBe(
            'chat.agent',
        );
        expect(
            view
                .allByTestId('setup-roles-super-roles-tag')
                .map((tag) => tag.textContent),
        ).toEqual(['super-admin']);

        expect(
            view
                .byTestId('setup-active-env-production')
                ?.getAttribute('aria-checked'),
        ).toBe('true');
        expect(
            view.byTestId('setup-active-env-testing')?.hasAttribute('disabled'),
        ).toBe(true);
    });

    it('never prefills a secret: a saved token is only indicated and not required again', async () => {
        const view = await render(
            <Setup
                {...portalSetup(
                    'pizzasys',
                    pizzasysData({
                        environments: {
                            production: env('production', {
                                configured: true,
                                base_url: 'https://auth.example.com',
                                service_name: 'pne-chat',
                                has_service_token: true,
                            }),
                            testing: env('testing'),
                        },
                    }),
                )}
            />,
        );
        const token = input(view, 'setup-env-production-service-token');

        expect(token?.value).toBe('');
        expect(token?.type).toBe('password');
        expect(token?.hasAttribute('required')).toBe(false);
        expect(
            view.byTestId('setup-env-production-service-token-saved')
                ?.textContent,
        ).toContain('Token saved.');
        expect(view.text()).toContain('Leave this empty to keep it');
        expect(input(view, 'setup-env-production-base-url')?.value).toBe(
            'https://auth.example.com',
        );
        // The page never holds the token anywhere in its markup.
        expect(view.container.innerHTML).not.toContain('service-secret');

        await click(view.byTestId('setup-pizzasys-submit'));

        // Valid without retyping it: the post goes out and omits the token.
        const sent = lastVisit('post');

        expect(sent.url).toBe('/setup/pizzasys');
        expect(
            (sent.data.environments as Record<string, Record<string, unknown>>)
                .production,
        ).not.toHaveProperty('service_token');
    });

    it('explains what is missing instead of posting an empty form', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await click(view.byTestId('setup-pizzasys-submit'));

        expect(routerMock.post).not.toHaveBeenCalled();
        expect(view.text()).toContain('This field is required.');
        expect(view.text()).toContain(
            'Paste the service token for this environment.',
        );

        const address = input(view, 'setup-env-production-base-url');

        expect(address?.getAttribute('aria-invalid')).toBe('true');
        expect(address?.getAttribute('aria-describedby')).toContain(
            'setup-env-production-base-url-error',
        );
        // Focus goes to the first problem.
        expect(document.activeElement).toBe(address);

        await typeInto(address, 'http://auth.example.com');
        // Typing clears that field's error; the next submit flags the scheme.
        expect(address?.getAttribute('aria-invalid')).toBeNull();

        await typeInto(
            input(view, 'setup-env-production-service-token'),
            'tok',
        );
        await click(view.byTestId('setup-pizzasys-submit'));

        expect(view.text()).toContain('Use https.');
        expect(routerMock.post).not.toHaveBeenCalled();
    });

    it('posts one payload with Production only, trimmed, with the roles flattened', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-pizzasys-submit'));

        expect(routerMock.post).toHaveBeenCalledTimes(1);

        const sent = lastVisit('post');

        expect(sent.url).toBe('/setup/pizzasys');
        expect(sent.data).toEqual({
            environments: {
                production: {
                    base_url: 'https://auth.example.com',
                    service_name: 'pne-chat',
                    verify_tls: true,
                    nats_url: null,
                    service_token: 'service-secret',
                },
            },
            active_env: 'production',
            admin_permission: 'chat.admin',
            agent_permission: 'chat.agent',
            super_roles: ['super-admin'],
        });
    });

    it('shows server-side errors under the nested field paths', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-pizzasys-submit'));
        await completeVisit(lastVisit('post'), {
            errors: {
                'environments.production.base_url':
                    'The production base url host is not allowed.',
                active_env: 'Choose a configured environment.',
            },
        });

        expect(view.text()).toContain(
            'The production base url host is not allowed.',
        );
        expect(view.text()).toContain('Choose a configured environment.');
        expect(
            input(view, 'setup-env-production-base-url')?.getAttribute(
                'aria-invalid',
            ),
        ).toBe('true');
    });

    it('lets Testing be added: it opens, is validated once typed into, and can become active', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-env-testing-toggle'));

        expect(input(view, 'setup-env-testing-base-url')).not.toBeNull();
        expect(
            view.byTestId('setup-env-test-testing')?.hasAttribute('disabled'),
        ).toBe(true);

        await typeInto(
            input(view, 'setup-env-testing-base-url'),
            'https://testing.example.com',
        );

        expect(
            view.byTestId('setup-env-test-testing')?.hasAttribute('disabled'),
        ).toBe(false);
        expect(
            view.byTestId('setup-active-env-testing')?.hasAttribute('disabled'),
        ).toBe(false);

        // Half-filled Testing blocks the post and names what is missing.
        await click(view.byTestId('setup-pizzasys-submit'));
        expect(routerMock.post).not.toHaveBeenCalled();
        expect(view.text()).toContain(
            'Paste the service token for this environment.',
        );

        await typeInto(
            input(view, 'setup-env-testing-service-name'),
            'pne-chat-test',
        );
        await typeInto(
            input(view, 'setup-env-testing-service-token'),
            'testing-secret',
        );
        await click(view.byTestId('setup-active-env-testing'));
        await click(view.byTestId('setup-pizzasys-submit'));

        const sent = lastVisit('post');

        expect(sent.data.active_env).toBe('testing');
        expect(
            (sent.data.environments as Record<string, unknown>).testing,
        ).toEqual({
            base_url: 'https://testing.example.com',
            service_name: 'pne-chat-test',
            verify_tls: true,
            nats_url: null,
            service_token: 'testing-secret',
        });
    });

    it('edits the super roles as tags and sends them', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);
        const tags = () =>
            view
                .allByTestId('setup-roles-super-roles-tag')
                .map((tag) => tag.textContent);
        const field = input(view, 'setup-roles-super-roles');

        await typeInto(field, 'Store Manager');
        await act(async () => {
            field?.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true,
                }),
            );
        });

        expect(tags()).toEqual(['super-admin', 'Store Manager']);

        // Removing a chip works by its labelled button.
        const remove = view.container.querySelector<HTMLButtonElement>(
            'button[aria-label="Remove super-admin"]',
        );

        await click(remove);
        expect(tags()).toEqual(['Store Manager']);

        await fillProduction(view);
        await click(view.byTestId('setup-pizzasys-submit'));

        expect(lastVisit('post').data.super_roles).toEqual(['Store Manager']);
    });

    it('refuses one permission name for both roles', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await typeInto(
            input(view, 'setup-roles-agent-permission'),
            'chat.admin',
        );
        await click(view.byTestId('setup-pizzasys-submit'));

        expect(routerMock.post).not.toHaveBeenCalled();
        expect(view.text()).toContain('every agent would be an admin');
    });

    it('goes back to the mode step', async () => {
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await click(view.byTestId('setup-back'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('mode');
    });
});

describe('testing the connection', () => {
    it('saves the form first, then shows every check with its message', async () => {
        const calls = stubFetch(() => ({ body: passingResult }));
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));

        // It saves with the same endpoint as Continue, and only then tests the saved values.
        expect(lastVisit('post').url).toBe('/setup/pizzasys');
        expect(calls).toHaveLength(0);
        expect(
            view.byTestId('setup-env-result-production')?.dataset.state,
        ).toBe('running');

        await completeVisit(lastVisit('post'));
        await flush();

        expect(calls).toEqual([
            { url: '/setup/pizzasys/test', body: { env: 'production' } },
        ]);

        const result = view.byTestId('setup-env-result-production');

        expect(result?.dataset.state).toBe('done');
        expect(result?.getAttribute('aria-live')).toBe('polite');
        expect(
            view.byTestId('setup-env-result-production-summary')?.textContent,
        ).toContain('Every check passed');
        for (const key of ['reachable', 'service_credential', 'latency']) {
            expect(
                view.byTestId(`setup-env-result-production-${key}`)?.dataset.ok,
            ).toBe('true');
        }
        expect(view.text()).toContain('212 ms');
        expect(view.byTestId('setup-env-verified-production')).not.toBeNull();
        // The typed token is cleared once saved, and the server's `tested` flags are pulled in.
        expect(input(view, 'setup-env-production-service-token')?.value).toBe(
            '',
        );
        expect(routerMock.reload).toHaveBeenCalledWith(
            expect.objectContaining({ only: ['setup'] }),
        );
    });

    it('explains a rejected service credential and how to fix it', async () => {
        stubFetch(() => ({
            body: {
                ok: false,
                checks: [
                    { key: 'reachable', label: 'Portal reachable', ok: true },
                    {
                        key: 'service_credential',
                        label: 'Service credential',
                        ok: false,
                        message: 'HTTP 401: Invalid service token.',
                    },
                ],
            },
        }));

        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));
        await completeVisit(lastVisit('post'));
        await flush();

        const row = view.byTestId(
            'setup-env-result-production-service_credential',
        );

        expect(row?.dataset.ok).toBe('false');
        expect(row?.dataset.tone).toBe('failed');
        expect(row?.textContent).toContain('HTTP 401: Invalid service token.');
        expect(
            view.byTestId('setup-env-result-production-service_credential-hint')
                ?.textContent,
        ).toContain('Create or rotate the service client');
        expect(
            view.byTestId('setup-env-result-production-summary')?.textContent,
        ).toContain('does not work yet');
        expect(view.byTestId('setup-env-verified-production')).toBeNull();
    });

    it('reads a failing NATS check beside a good result as a warning, not a failure', async () => {
        stubFetch(() => ({
            body: {
                ok: true,
                checks: [
                    { key: 'reachable', label: 'Portal reachable', ok: true },
                    {
                        key: 'nats',
                        label: 'NATS',
                        ok: false,
                        message: 'connection refused',
                    },
                ],
            },
        }));

        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));
        await completeVisit(lastVisit('post'));
        await flush();

        expect(
            view.byTestId('setup-env-result-production-nats')?.dataset.tone,
        ).toBe('warning');
        expect(
            view.byTestId('setup-env-result-production-summary')?.textContent,
        ).toContain('with a warning');
        expect(view.byTestId('setup-env-verified-production')).not.toBeNull();
    });

    it('does not test an invalid form and shows nothing running', async () => {
        const calls = stubFetch(() => ({ body: passingResult }));
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await click(view.byTestId('setup-env-test-production'));

        expect(routerMock.post).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
        expect(
            view.byTestId('setup-env-result-production')?.dataset.state,
        ).toBe('idle');
        expect(view.text()).toContain('This field is required.');
    });

    it('stops when the save is refused and keeps the server errors on the fields', async () => {
        const calls = stubFetch(() => ({ body: passingResult }));
        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));
        await completeVisit(lastVisit('post'), {
            errors: {
                'environments.production.service_name':
                    'Service name is taken.',
            },
        });
        await flush();

        expect(calls).toHaveLength(0);
        expect(
            view.byTestId('setup-env-result-production')?.dataset.state,
        ).toBe('idle');
        expect(view.text()).toContain('Service name is taken.');
    });

    it('says plainly when the test itself could not run', async () => {
        stubFetch(() => ({ status: 429, body: {} }));

        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));
        await completeVisit(lastVisit('post'));
        await flush();

        expect(
            view.byTestId('setup-env-result-production')?.dataset.state,
        ).toBe('error');
        expect(
            view.byTestId('setup-env-result-production-error')?.textContent,
        ).toContain('Too many attempts');
    });

    it('keeps the screen in place while the server already moves the wizard on, and Continue then follows the server', async () => {
        stubFetch(() => ({ body: passingResult }));

        const view = await render(
            <Harness initial={portalSetup('pizzasys')} />,
        );

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));

        // The saved form makes the server consider this step done ...
        await act(async () => {
            setPageProps(portalSetup('portal-admin'));
        });
        await completeVisit(lastVisit('post'));
        await flush();

        // ... but the user is still looking at the test result.
        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('pizzasys');
        expect(
            view.byTestId('setup-env-result-production')?.dataset.state,
        ).toBe('done');

        // Continue saves for real and then hands control back to the server's step.
        await click(view.byTestId('setup-pizzasys-submit'));
        await completeVisit(lastVisit('post'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe(
            'portal-admin',
        );
    });

    it('lets Back leave a held step', async () => {
        stubFetch(() => ({ body: passingResult }));

        const view = await render(
            <Harness initial={portalSetup('pizzasys')} />,
        );

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));
        await act(async () => {
            setPageProps(portalSetup('portal-admin'));
        });
        await completeVisit(lastVisit('post'));
        await flush();
        await click(view.byTestId('setup-back'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('mode');
    });
});

describe('portal-admin step', () => {
    const credentials = {
        email: 'chatadmin@example.com',
        password: 'correct horse',
    };

    async function submit(view: Awaited<ReturnType<typeof render>>) {
        await typeInto(input(view, 'setup-portal-email'), credentials.email);
        await typeInto(
            input(view, 'setup-portal-password'),
            credentials.password,
        );
        await click(view.byTestId('setup-portal-submit'));
        await flush();
    }

    it('asks for an email and password and says which portal it will use', async () => {
        const view = await render(
            <Setup
                {...portalSetup(
                    'portal-admin',
                    pizzasysData({
                        environments: {
                            production: env('production', {
                                configured: true,
                                base_url: 'https://auth.example.com',
                            }),
                            testing: env('testing'),
                        },
                    }),
                )}
            />,
        );

        expect(view.byTestId('setup-step-portal-admin')).not.toBeNull();
        expect(input(view, 'setup-portal-email')?.type).toBe('email');
        expect(input(view, 'setup-portal-password')?.type).toBe('password');
        expect(view.byTestId('setup-portal-target')?.textContent).toContain(
            'Production (auth.example.com)',
        );
        expect(view.text()).toContain('chat.admin');
        expect(view.byTestId('setup-portal-continue')).toBeNull();
    });

    it('posts the credentials as JSON and shows the verified admin', async () => {
        const calls = stubFetch(() => ({
            body: {
                ok: true,
                user: { name: 'Chat Admin', email: credentials.email },
                isAdmin: true,
            },
        }));
        const view = await render(<Setup {...portalSetup('portal-admin')} />);

        await submit(view);

        expect(calls).toEqual([
            { url: '/setup/portal-admin', body: credentials },
        ]);
        expect(view.byTestId('setup-portal-verified')).not.toBeNull();
        expect(view.byTestId('setup-portal-verified-name')?.textContent).toBe(
            'Chat Admin',
        );
        expect(view.byTestId('setup-portal-verified-email')?.textContent).toBe(
            credentials.email,
        );
        // The password never stays in the page.
        expect(view.container.innerHTML).not.toContain(credentials.password);
        expect(view.byTestId('setup-portal-submit')).toBeNull();
        expect(document.activeElement).toBe(
            view.byTestId('setup-portal-continue'),
        );
    });

    it('continues to the basics step and syncs the server state', async () => {
        stubFetch(() => ({
            body: {
                ok: true,
                user: { name: 'Chat Admin', email: credentials.email },
                isAdmin: true,
            },
        }));

        const view = await render(<Setup {...portalSetup('portal-admin')} />);

        await submit(view);
        await click(view.byTestId('setup-portal-continue'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('basics');
        expect(routerMock.reload).toHaveBeenCalledWith(
            expect.objectContaining({ only: ['setup'] }),
        );
    });

    it.each([
        ['invalid', 'did not accept those details'],
        ['unavailable', 'could not complete the sign-in'],
        ['no_chat_access', 'No chat permission'],
        ['not_admin', 'not an administrator'],
    ])('tells "%s" apart with its own message', async (code, expected) => {
        stubFetch(() => ({
            status: 422,
            body: { ok: false, message: 'server text', code },
        }));

        const view = await render(<Setup {...portalSetup('portal-admin')} />);

        await submit(view);

        const problem = view.byTestId('setup-portal-problem');

        expect(problem?.dataset.code).toBe(code);
        expect(problem?.getAttribute('role')).toBe('alert');
        expect(problem?.textContent).toContain(expected);
        expect(view.byTestId('setup-portal-verified')).toBeNull();
        expect(view.byTestId('setup-portal-continue')).toBeNull();
        // The password is cleared and focus returns to it for another try.
        expect(input(view, 'setup-portal-password')?.value).toBe('');
        expect(document.activeElement).toBe(
            input(view, 'setup-portal-password'),
        );
    });

    it('uses the configured admin permission name in the hints', async () => {
        stubFetch(() => ({
            status: 422,
            body: { ok: false, message: 'x', code: 'not_admin' },
        }));

        const view = await render(
            <Setup
                {...portalSetup(
                    'portal-admin',
                    pizzasysData({
                        roles: {
                            admin_permission: 'chat.owner',
                            agent_permission: 'chat.agent',
                            super_roles: [],
                        },
                    }),
                )}
            />,
        );

        await submit(view);

        expect(view.byTestId('setup-portal-problem')?.textContent).toContain(
            'chat.owner',
        );
    });

    it('reports a throttled or unreachable server without blaming the credentials', async () => {
        stubFetch(() => ({ status: 429, body: {} }));

        const view = await render(<Setup {...portalSetup('portal-admin')} />);

        await submit(view);

        expect(view.byTestId('setup-portal-problem')?.dataset.code).toBe(
            'throttled',
        );
        expect(view.byTestId('setup-portal-problem')?.textContent).toContain(
            'Too many attempts',
        );
    });

    it('resumes with the admin verified earlier and lets the user pick another account', async () => {
        const view = await render(
            <Setup
                {...portalSetup(
                    'portal-admin',
                    pizzasysData({
                        portal_admin: {
                            name: 'Mina Haddad',
                            email: 'mina@example.com',
                        },
                    }),
                )}
            />,
        );

        expect(view.byTestId('setup-portal-verified-name')?.textContent).toBe(
            'Mina Haddad',
        );
        expect(view.byTestId('setup-portal-continue')).not.toBeNull();
        expect(input(view, 'setup-portal-email')).toBeNull();

        await click(view.byTestId('setup-portal-change'));

        expect(input(view, 'setup-portal-email')).not.toBeNull();
        expect(view.byTestId('setup-portal-submit')).not.toBeNull();
    });

    it('goes back to the environments', async () => {
        const view = await render(<Setup {...portalSetup('portal-admin')} />);

        await click(view.byTestId('setup-back'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('pizzasys');
    });

    it('can be driven with an injected client', async () => {
        const client = createPortalClient({
            fetchImpl: (async () =>
                new Response(
                    JSON.stringify({
                        ok: false,
                        message: 'm',
                        code: 'invalid',
                    }),
                    { status: 422 },
                )) as unknown as typeof fetch,
            xsrfToken: () => null,
        });
        const view = await render(
            <StepPortalAdmin
                setup={portalSetup('portal-admin').setup}
                onBack={() => {}}
                onContinue={() => {}}
                client={client}
            />,
        );

        await submit(view);

        expect(view.byTestId('setup-portal-problem')?.dataset.code).toBe(
            'invalid',
        );
    });
});

describe('basics step in the Auth Portal flow', () => {
    it('goes back to the verified portal login, not to the admin step', async () => {
        const view = await render(<Setup {...portalSetup('basics')} />);

        await click(view.byTestId('setup-back'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe(
            'portal-admin',
        );
    });
});

describe('run step in the Auth Portal flow', () => {
    it('keeps the same four install steps and summarises the portal and its admin', async () => {
        const view = await render(
            <Setup
                {...portalSetup(
                    'run',
                    pizzasysData({
                        environments: {
                            production: env('production', {
                                configured: true,
                                base_url: 'https://auth.example.com',
                            }),
                            testing: env('testing'),
                        },
                        portal_admin: {
                            name: 'Mina Haddad',
                            email: 'mina@example.com',
                        },
                    }),
                )}
            />,
        );

        for (const key of [
            'run-migrations',
            'seed-defaults',
            'create-admin',
            'write-lock',
        ]) {
            expect(view.byTestId(`setup-run-row-${key}`)).not.toBeNull();
        }

        const summary = view.byTestId('setup-run-summary')?.textContent ?? '';

        expect(summary).toContain('Auth Portal (pizzasys)');
        expect(
            view.byTestId('setup-run-summary-portal')?.textContent,
        ).toContain('https://auth.example.com');
        expect(summary).toContain('Mina Haddad');
        expect(summary).toContain('mina@example.com');
    });

    it('runs them in order and finishes on the Auth Portal wording', async () => {
        const calls = stubFetch((url) => ({
            body: url.endsWith('write-lock')
                ? { status: 'ok', next: null, redirect: '/login' }
                : { status: 'ok', next: 'x' },
        }));
        const view = await render(<Setup {...portalSetup('run')} />);

        await click(view.byTestId('setup-run-start'));
        await flush();
        await flush();

        expect(calls.map((call) => call.url)).toEqual([
            '/setup/run/run-migrations',
            '/setup/run/seed-defaults',
            '/setup/run/create-admin',
            '/setup/run/write-lock',
        ]);
        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('done');
        expect(view.text()).toContain('Sign in with your Auth Portal account');
    });
});

describe('StepPizzasys on its own', () => {
    it('reports holding and releasing the view', async () => {
        stubFetch(() => ({ body: passingResult }));

        const onHold = vi.fn();
        const view = await render(
            <StepPizzasys
                setup={portalSetup('pizzasys').setup}
                onBack={() => {}}
                onHold={onHold}
            />,
        );

        await fillProduction(view);
        await click(view.byTestId('setup-env-test-production'));

        expect(onHold).toHaveBeenLastCalledWith('pizzasys');

        await completeVisit(lastVisit('post'));
        await flush();
        await click(view.byTestId('setup-pizzasys-submit'));
        await completeVisit(lastVisit('post'));

        expect(onHold).toHaveBeenLastCalledWith(null);
    });
});

describe('translations', () => {
    it('renders the Auth Portal step in Arabic (rtl) with English fallback for missing keys', async () => {
        resetInertiaMock({ locale: 'ar', direction: 'rtl' });

        const { i18n } = await import('@/hooks/use-trans');

        await i18n.load('ar');

        const view = await render(<Setup {...portalSetup('pizzasys')} />);

        expect(view.byTestId('setup-step-pizzasys')?.textContent).toContain(
            'اربط بوابة المصادقة',
        );
        // The stepper takes the portal steps' labels from their own prefix.
        expect(
            view.byTestId('setup-stepper-item-portal-admin')?.textContent,
        ).toContain('مسؤول البوابة');
        expect(view.byTestId('setup-env-test-production')?.textContent).toBe(
            'اختبار الاتصال',
        );
        // Not translated in the stub: falls back to English.
        expect(view.text()).toContain('Portal address');
        // Identifiers stay left to right inside the right-to-left page.
        expect(
            input(view, 'setup-env-production-base-url')?.getAttribute('dir'),
        ).toBe('ltr');
    });
});
