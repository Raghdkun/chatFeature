import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { StepDone } from '@/components/setup/step-done';
import { StepRun } from '@/components/setup/step-run';
import type { RunStepClient } from '@/lib/setup-flow';
import Setup from '@/pages/setup/index';
import {
    inertiaState,
    resetInertiaMock,
    routerMock,
} from '@/tests/inertia-mock';
import { click, flush, render, typeInto } from '@/tests/render';
import type {
    SetupProps,
    SetupRunRow,
    SetupState,
    SetupStepKey,
} from '@/types/setup';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const STEP_LABELS: Record<SetupStepKey, string> = {
    welcome: 'Welcome',
    mode: 'Mode',
    admin: 'Admin',
    basics: 'Basics',
    run: 'Run',
    done: 'Done',
};

const ORDER: SetupStepKey[] = [
    'welcome',
    'mode',
    'admin',
    'basics',
    'run',
    'done',
];

const runRows = (statuses: SetupRunRow['status'][] = []): SetupRunRow[] =>
    ['run-migrations', 'seed-defaults', 'create-admin', 'write-lock'].map(
        (key, index) => ({
            key,
            label: `Server label for ${key}`,
            status: statuses[index] ?? 'pending',
        }),
    );

function makeSetup(
    step: SetupStepKey,
    overrides: Partial<SetupState> = {},
): SetupProps {
    const current = ORDER.indexOf(step);

    return {
        setup: {
            step,
            steps: ORDER.map((key, index) => ({
                key,
                label: STEP_LABELS[key],
                status:
                    index < current
                        ? 'done'
                        : index === current
                          ? 'current'
                          : 'pending',
            })),
            needsToken: false,
            tokenVerified: false,
            mode: 'fortify',
            pizzasysAvailable: false,
            environment: {
                ok: true,
                checks: [
                    { key: 'php', label: 'PHP 8.4', ok: true },
                    { key: 'storage', label: 'storage/ is writable', ok: true },
                ],
            },
            defaults: {
                app_name: 'PNE Chat',
                app_url: 'http://localhost:8000',
                locale: 'en',
                timezone: 'Europe/Berlin',
                idle_timeout_minutes: 120,
            },
            admin: null,
            run: runRows(),
            ...overrides,
        },
    };
}

beforeEach(() => resetInertiaMock());

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('welcome step', () => {
    it('asks for the setup token first and holds the environment check back', async () => {
        const view = await render(
            <Setup
                {...makeSetup('welcome', {
                    needsToken: true,
                    tokenVerified: false,
                })}
            />,
        );

        expect(view.byTestId('setup-step-welcome')).not.toBeNull();
        expect(view.byTestId('setup-token')).not.toBeNull();
        expect(
            view.container.querySelector<HTMLInputElement>(
                'input[name="token"]',
            ),
        ).not.toBeNull();
        expect(
            view.container.querySelector('form')?.getAttribute('action'),
        ).toBe('/setup/token');
        expect(view.byTestId('setup-token-submit')).not.toBeNull();
        expect(view.byTestId('setup-environment')).toBeNull();
        expect(
            view.byTestId('setup-welcome-continue')?.hasAttribute('disabled'),
        ).toBe(true);
    });

    it('shows the validation error under the token field', async () => {
        inertiaState.formErrors = { token: 'The setup token is not valid.' };

        const view = await render(
            <Setup {...makeSetup('welcome', { needsToken: true })} />,
        );

        const input = view.container.querySelector('input[name="token"]');
        const errorId = input?.getAttribute('aria-describedby') ?? '';

        expect(view.text()).toContain('The setup token is not valid.');
        expect(input?.getAttribute('aria-invalid')).toBe('true');
        expect(errorId).toContain('setup-token-input-error');
    });

    it('lists the environment checks once the token is verified, then continues to the mode step', async () => {
        const view = await render(
            <Setup
                {...makeSetup('welcome', {
                    needsToken: true,
                    tokenVerified: true,
                })}
            />,
        );

        expect(view.byTestId('setup-token')).toBeNull();
        expect(view.byTestId('setup-token-verified')).not.toBeNull();
        expect(view.byTestId('setup-env-check-php')?.dataset.ok).toBe('true');
        expect(view.byTestId('setup-env-summary')?.textContent).toContain(
            'Everything this server needs is in place.',
        );

        const next = view.byTestId('setup-welcome-continue');

        expect(next?.hasAttribute('disabled')).toBe(false);

        await click(next);

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('mode');
        expect(view.byTestId('setup-step-mode')).not.toBeNull();
    });

    it('shows failed checks with their messages and re-runs them on retry', async () => {
        const view = await render(
            <Setup
                {...makeSetup('welcome', {
                    environment: {
                        ok: false,
                        checks: [
                            { key: 'php', label: 'PHP 8.4', ok: true },
                            {
                                key: 'db',
                                label: 'Database',
                                ok: false,
                                message:
                                    'SQLSTATE[HY000] [2002] Connection refused',
                            },
                        ],
                    },
                })}
            />,
        );

        expect(view.byTestId('setup-env-check-db')?.dataset.ok).toBe('false');
        expect(view.byTestId('setup-env-check-db')?.textContent).toContain(
            'Connection refused',
        );
        expect(view.byTestId('setup-env-summary')?.textContent).toContain(
            'One check needs attention',
        );
        expect(
            view.byTestId('setup-welcome-continue')?.hasAttribute('disabled'),
        ).toBe(true);

        await click(view.byTestId('setup-env-retry'));

        expect(routerMock.reload).toHaveBeenCalledWith(
            expect.objectContaining({ only: ['setup'] }),
        );
    });
});

describe('mode step', () => {
    it('offers starter kit auth and a disabled "Coming soon" Auth Portal', async () => {
        const view = await render(<Setup {...makeSetup('mode')} />);

        const fortify = view.container.querySelector<HTMLInputElement>(
            '#setup-mode-fortify',
        );
        const pizzasys = view.container.querySelector<HTMLInputElement>(
            '#setup-mode-pizzasys',
        );

        expect(
            view.container.querySelector('form')?.getAttribute('action'),
        ).toBe('/setup/mode');
        expect(fortify?.checked).toBe(true);
        expect(fortify?.disabled).toBe(false);
        expect(pizzasys?.disabled).toBe(true);
        expect(view.byTestId('setup-mode-badge-pizzasys')?.textContent).toBe(
            'Coming soon',
        );
        expect(view.text()).toContain('Starter kit auth');
        expect(view.text()).toContain('Auth Portal (pizzasys)');
        expect(view.byTestId('setup-mode-submit')).not.toBeNull();
    });

    it('enables the Auth Portal card (and drops the badge) once the backend supports it', async () => {
        const view = await render(
            <Setup
                {...makeSetup('mode', {
                    pizzasysAvailable: true,
                    mode: 'pizzasys',
                })}
            />,
        );

        const pizzasys = view.container.querySelector<HTMLInputElement>(
            '#setup-mode-pizzasys',
        );

        expect(pizzasys?.disabled).toBe(false);
        expect(pizzasys?.checked).toBe(true);
        expect(view.byTestId('setup-mode-badge-pizzasys')).toBeNull();
    });

    it('shows a server-side mode error', async () => {
        inertiaState.formErrors = { mode: 'Auth Portal is not available yet.' };

        const view = await render(<Setup {...makeSetup('mode')} />);

        expect(view.text()).toContain('Auth Portal is not available yet.');
    });
});

describe('admin step', () => {
    it('renders the four admin fields prefilled from the server (never the password)', async () => {
        const view = await render(
            <Setup
                {...makeSetup('admin', {
                    admin: { name: 'Mina Haddad', email: 'mina@example.com' },
                })}
            />,
        );
        const field = (name: string) =>
            view.container.querySelector<HTMLInputElement>(
                `input[name="${name}"]`,
            );

        expect(
            view.container.querySelector('form')?.getAttribute('action'),
        ).toBe('/setup/admin');
        expect(field('name')?.value).toBe('Mina Haddad');
        expect(field('email')?.value).toBe('mina@example.com');
        expect(field('password')?.value).toBe('');
        expect(field('password')?.type).toBe('password');
        expect(field('password_confirmation')).not.toBeNull();
        expect(view.byTestId('setup-admin-submit')).not.toBeNull();
    });

    it('shows inline errors for each field', async () => {
        inertiaState.formErrors = {
            email: 'The email has already been taken.',
            password: 'The password is too short.',
        };

        const view = await render(<Setup {...makeSetup('admin')} />);

        expect(view.text()).toContain('The email has already been taken.');
        expect(view.text()).toContain('The password is too short.');
    });

    it('goes back to the mode step without leaving the page', async () => {
        const view = await render(<Setup {...makeSetup('admin')} />);

        await click(view.byTestId('setup-back'));

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('mode');
    });
});

describe('basics step', () => {
    it('renders the basics fields with the server defaults', async () => {
        const view = await render(<Setup {...makeSetup('basics')} />);
        const input = (name: string) =>
            view.container.querySelector<HTMLInputElement>(
                `input[name="${name}"]`,
            );
        const select = (name: string) =>
            view.container.querySelector<HTMLSelectElement>(
                `select[name="${name}"]`,
            );

        expect(
            view.container.querySelector('form')?.getAttribute('action'),
        ).toBe('/setup/basics');
        expect(input('app_name')?.value).toBe('PNE Chat');
        expect(input('app_url')?.value).toBe('http://localhost:8000');
        expect(input('idle_timeout_minutes')?.value).toBe('120');
        expect(input('idle_timeout_minutes')?.min).toBe('5');
        expect(input('idle_timeout_minutes')?.max).toBe('1440');
        expect(select('locale')?.value).toBe('en');
        expect(
            Array.from(select('locale')?.options ?? []).map((o) => o.value),
        ).toEqual(expect.arrayContaining(['en', 'ar']));
        expect(select('timezone')?.value).toBe('Europe/Berlin');
        expect(select('timezone')?.options.length).toBeGreaterThan(100);
    });

    it('explains the idle timeout and keeps the helper in step with the input', async () => {
        const view = await render(<Setup {...makeSetup('basics')} />);
        const hint = () =>
            view.container.querySelector('#setup-idle-timeout-hint')
                ?.textContent;

        expect(hint()).toBe(
            'Chats close automatically after 120 minutes without messages. Default: 120.',
        );

        await typeInto(
            view.container.querySelector<HTMLInputElement>(
                'input[name="idle_timeout_minutes"]',
            ),
            '45',
        );

        expect(hint()).toContain('after 45 minutes');

        await typeInto(
            view.container.querySelector<HTMLInputElement>(
                'input[name="idle_timeout_minutes"]',
            ),
            '9999',
        );

        expect(view.text()).toContain('Use a whole number from 5 to 1440.');
    });

    it('includes the server default time zone even if the browser does not list it', async () => {
        const view = await render(
            <Setup
                {...makeSetup('basics', {
                    defaults: {
                        app_name: 'x',
                        app_url: 'http://x.test',
                        locale: 'en',
                        timezone: 'Mars/Olympus_Mons',
                        idle_timeout_minutes: 120,
                    },
                })}
            />,
        );

        expect(
            view.container.querySelector<HTMLSelectElement>(
                'select[name="timezone"]',
            )?.value,
        ).toBe('Mars/Olympus_Mons');
    });
});

describe('run step', () => {
    it('lists the install steps and offers an explicit start button', async () => {
        const view = await render(<Setup {...makeSetup('run')} />);

        expect(view.byTestId('setup-step-run')).not.toBeNull();
        expect(view.allByTestId('setup-run-progress').length).toBe(1);
        for (const key of [
            'run-migrations',
            'seed-defaults',
            'create-admin',
            'write-lock',
        ]) {
            expect(view.byTestId(`setup-run-row-${key}`)?.dataset.status).toBe(
                'pending',
            );
        }
        expect(view.byTestId('setup-run-start')?.textContent).toContain(
            'Start installation',
        );
        expect(view.byTestId('setup-run-summary')?.textContent).toContain(
            'Europe/Berlin',
        );
    });

    it('runs every step in order, announces progress and hands over to the done step', async () => {
        const calls: string[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                calls.push(url);

                return new Response(
                    JSON.stringify(
                        url.endsWith('write-lock')
                            ? { status: 'ok', next: null, redirect: '/login' }
                            : { status: 'ok', next: 'x' },
                    ),
                    { status: 200 },
                );
            }),
        );

        const view = await render(<Setup {...makeSetup('run')} />);

        await click(view.byTestId('setup-run-start'));
        await flush();
        await flush();

        expect(calls).toEqual([
            '/setup/run/run-migrations',
            '/setup/run/seed-defaults',
            '/setup/run/create-admin',
            '/setup/run/write-lock',
        ]);
        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('done');
        expect(view.byTestId('setup-done-login')?.getAttribute('href')).toBe(
            '/login',
        );
    });
});

describe('StepRun', () => {
    const setup = makeSetup('run').setup;

    it('marks a failing step, shows the server message and retries from that step', async () => {
        let seedCalls = 0;
        const calls: string[] = [];
        const runStep: RunStepClient = async (step) => {
            calls.push(step);

            if (step === 'seed-defaults' && ++seedCalls === 1) {
                return { status: 'failed', message: 'Disk quota exceeded' };
            }

            return { status: 'ok', next: null, redirect: '/login' };
        };
        const onCompleted = vi.fn();
        const view = await render(
            <StepRun
                setup={setup}
                onBack={() => {}}
                onCompleted={onCompleted}
                runStep={runStep}
            />,
        );

        await click(view.byTestId('setup-run-start'));
        await flush();

        expect(
            view.byTestId('setup-run-row-run-migrations')?.dataset.status,
        ).toBe('done');
        expect(
            view.byTestId('setup-run-row-seed-defaults')?.dataset.status,
        ).toBe('failed');
        expect(
            view.byTestId('setup-run-message-seed-defaults')?.textContent,
        ).toBe('Disk quota exceeded');
        expect(
            view.byTestId('setup-run-row-create-admin')?.dataset.status,
        ).toBe('pending');
        expect(view.byTestId('setup-run-live')?.textContent).toContain(
            'Failed: Add the default settings. Disk quota exceeded',
        );
        expect(onCompleted).not.toHaveBeenCalled();

        const retry = view.byTestId('setup-run-retry');

        expect(retry?.textContent).toContain('Retry from the failed step');

        await click(retry);
        await flush();

        expect(calls).toEqual([
            'run-migrations',
            'seed-defaults',
            'seed-defaults',
            'create-admin',
            'write-lock',
        ]);
        expect(onCompleted).toHaveBeenCalledWith('/login');
    });

    it('explains a client-side failure in plain words', async () => {
        const view = await render(
            <StepRun
                setup={setup}
                onBack={() => {}}
                onCompleted={() => {}}
                runStep={async () => ({ status: 'failed', code: 'conflict' })}
            />,
        );

        await click(view.byTestId('setup-run-start'));
        await flush();

        expect(
            view.byTestId('setup-run-message-run-migrations')?.textContent,
        ).toBe('Another setup run is in progress. Wait a moment, then retry.');
    });

    it('offers to continue when some steps already ran', async () => {
        const view = await render(
            <StepRun
                setup={
                    makeSetup('run', { run: runRows(['done', 'pending']) })
                        .setup
                }
                onBack={() => {}}
                onCompleted={() => {}}
                runStep={async () => ({ status: 'ok', next: null })}
            />,
        );

        expect(view.byTestId('setup-run-start')?.textContent).toContain(
            'Continue installation',
        );
        expect(
            view.byTestId('setup-run-row-run-migrations')?.dataset.status,
        ).toBe('done');
    });
});

describe('done step', () => {
    it('links to sign-in and moves there on its own after a short pause', async () => {
        vi.useFakeTimers();

        const navigate = vi.fn();
        const view = await render(
            <StepDone redirect="/login" navigate={navigate} />,
        );

        expect(view.byTestId('setup-step-done')).not.toBeNull();
        expect(view.byTestId('setup-done-login')?.getAttribute('href')).toBe(
            '/login',
        );
        expect(navigate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2600);

        expect(navigate).toHaveBeenCalledWith('/login');
    });

    it('is what the page renders when the server says the step is done', async () => {
        const view = await render(<Setup {...makeSetup('done')} />);

        expect(view.byTestId('setup-wizard')?.dataset.view).toBe('done');
        expect(view.byTestId('setup-done-login')?.getAttribute('href')).toBe(
            '/login',
        );
    });
});

describe('stepper', () => {
    it('shows each step with its status and marks the current one', async () => {
        const view = await render(<Setup {...makeSetup('admin')} />);

        expect(
            view.byTestId('setup-stepper-item-welcome')?.dataset.status,
        ).toBe('done');
        expect(view.byTestId('setup-stepper-item-admin')?.dataset.status).toBe(
            'current',
        );
        expect(
            view
                .byTestId('setup-stepper-item-admin')
                ?.getAttribute('aria-current'),
        ).toBe('step');
        expect(view.byTestId('setup-stepper-item-run')?.dataset.status).toBe(
            'pending',
        );
        expect(view.byTestId('setup-stepper-compact')?.textContent).toContain(
            'Step 3 of 6',
        );
    });

    it('omits the admin step for the Auth Portal mode', async () => {
        const base = makeSetup('basics', { mode: 'pizzasys' });
        const view = await render(
            <Setup
                setup={{
                    ...base.setup,
                    steps: base.setup.steps.filter((s) => s.key !== 'admin'),
                }}
            />,
        );

        expect(view.byTestId('setup-stepper-item-admin')).toBeNull();
        expect(view.byTestId('setup-stepper-compact')?.textContent).toContain(
            'Step 3 of 5',
        );
    });
});

describe('translations', () => {
    it('renders the wizard in Arabic (rtl) with English fallback for missing keys', async () => {
        resetInertiaMock({ locale: 'ar', direction: 'rtl' });

        const { i18n } = await import('@/hooks/use-trans');

        await i18n.load('ar');

        const view = await render(<Setup {...makeSetup('mode')} />);

        expect(view.text()).toContain('كيف سيسجّل الأشخاص دخولهم؟');
        expect(view.text()).toContain('قريبًا');
        // Not translated in the stub: falls back to English.
        expect(view.text()).toContain('Starter kit auth');
    });
});
