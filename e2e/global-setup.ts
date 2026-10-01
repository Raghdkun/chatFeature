/**
 * Runs once before the suite. Resets every active scenario to a known state:
 *
 *   1. wipe the scenario's private storage directory (sessions, cache, logs, install state/lock);
 *   2. create the `chatfeature_e2e*` database if it does not exist yet;
 *   3. `chat:install:reset --force` (env-scoped, wipes ONLY that database);
 *   4. per kind: nothing (`fresh`), stored wizard answers (`seeded`), or a real
 *      `chat:install --mode=local` plus the extra test accounts and saved logins (`installed`).
 *
 * Mode-2 scenarios (`auth: 'pizzasys'`) additionally need the local pizzasys harness
 * (e2e/support/harness.ts): it is started first (and stopped again in the teardown), `seeded` ones get
 * mode-2 wizard answers, `installed` ones a real `chat:install --mode=pizzasys` against it.
 *
 * Note: Playwright starts the `webServer`s BEFORE `globalSetup`. That is fine because the
 * servers are only waited for on a static file (no Laravel boot) and the tests start after this
 * function returned.
 */
import { execFile } from 'node:child_process';
import { readdir, mkdir, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { request } from '@playwright/test';
import { artisan, tinker } from './support/artisan';
import {
    ACTIVE_INSTANCES,
    assertSafe,
    ROOT,
    type Instance,
} from './support/scenarios';
import {
    bootHarness,
    ensureHarnessUsers,
    harnessSecrets,
    stopHarness,
} from './support/harness';
import {
    ADMIN,
    ADMIN_ONLY,
    AGENT,
    authStatePath,
    EXTRA_USERS,
    P3_CATEGORIES,
    portalSessionUser,
    portalUsers,
    SARA,
    TARIQ,
    type Role,
    type TestUser,
} from './support/users';
import { Api, createWidget } from './support/api';

const CREATE_DATABASE = `
$name = (string) getenv('E2E_DB_NAME');
if (! preg_match('/^chatfeature_e2e[a-z0-9_]*$/', $name)) { throw new RuntimeException('Unsafe database name: '.$name); }
config(['database.connections.mysql.database' => null]);
DB::purge('mysql');
DB::statement("CREATE DATABASE IF NOT EXISTS \`{$name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
`;

const STORE_WIZARD_ANSWERS = `
$answers = app(\\App\\Domain\\Install\\Actions\\StoreInstallAnswers::class);
$answers->mode('fortify');
$answers->admin((string) getenv('E2E_ADMIN_NAME'), (string) getenv('E2E_ADMIN_EMAIL'), (string) getenv('E2E_ADMIN_PASSWORD'));
$answers->basics(\\App\\Domain\\Install\\Actions\\StoreInstallAnswers::defaultBasics());
`;

const CREATE_USERS = `
foreach (json_decode((string) getenv('E2E_USERS_JSON'), true) as $user) {
    $factory = \\App\\Models\\User::factory();
    $factory = match ($user['kind']) {
        'agent' => $factory->agent(),
        'no-access' => $factory->withoutChatAccess(),
        'admin-only' => $factory->admin()->state(['is_agent' => false]),
        default => $factory->admin(),
    };
    if (! empty($user['unverified'])) { $factory = $factory->unverified(); }
    $factory->create(['name' => $user['name'], 'email' => $user['email'], 'password' => $user['password']]);
}
`;

/**
 * P3 `seed: 'staff'`: the staff accounts and three more categories (General comes from the installer); Sara serves
 * Billing + Sales, Tariq Technical support, everybody else nothing.
 */
const SEED_P3_STAFF = `
foreach (json_decode((string) getenv('E2E_P3_CATEGORIES'), true) as $position => $row) {
    \\App\\Models\\Category::query()->updateOrCreate(['slug' => $row['slug']], [
        'name' => $row['name'], 'icon' => $row['icon'], 'color' => $row['color'], 'sort_order' => $position + 1, 'is_active' => true,
    ]);
}
$served = ['sara' => [], 'tariq' => []];
foreach (json_decode((string) getenv('E2E_P3_CATEGORIES'), true) as $row) {
    foreach ($row['servedBy'] as $who) { $served[$who][] = $row['slug']; }
}
foreach (json_decode((string) getenv('E2E_P3_STAFF_JSON'), true) as $user) {
    $factory = \\App\\Models\\User::factory();
    $factory = match ($user['kind']) {
        'admin-only' => $factory->admin()->state(['is_agent' => false]),
        default => $factory->agent(),
    };
    $model = $factory->create(['name' => $user['name'], 'email' => $user['email'], 'password' => $user['password']]);
    $who = $user['serves'] ?? null;
    if ($who !== null) {
        $ulids = \\App\\Models\\Category::query()->whereIn('slug', $served[$who])->pluck('ulid')->all();
        app(\\App\\Domain\\Catalog\\Actions\\SyncUserCategories::class)->handle($model, $ulids, $model);
    }
}
`;

/** Mode 2: portal environment, roles and a verified portal administrator, so every wizard screen can be opened. */
const STORE_PIZZASYS_ANSWERS = `
$answers = app(\\App\\Domain\\Install\\Actions\\StoreInstallAnswers::class);
$answers->mode('pizzasys');
$answers->pizzasys(
    ['production' => [
        'base_url' => (string) getenv('E2E_PORTAL_URL'),
        'service_name' => (string) getenv('E2E_PORTAL_SERVICE'),
        'service_token' => (string) getenv('E2E_PORTAL_TOKEN'),
        'nats_url' => null,
        'nats_token' => null,
        'verify_tls' => true,
    ]],
    'production',
    new \\App\\Auth\\Roles\\RoleMapping('chat.admin', 'chat.agent', ['super-admin']),
);
$answers->portalAdmin('production', '1', 'Test Admin', 'admin@test.local', ['super-admin'], []);
$answers->basics(\\App\\Domain\\Install\\Actions\\StoreInstallAnswers::defaultBasics());
`;

async function prepare(instance: Instance): Promise<void> {
    assertSafe(instance);

    await rm(instance.dir, { recursive: true, force: true });
    await Promise.all(
        [
            'app',
            'state',
            'auth',
            'logs',
            'framework/cache/data',
            'framework/sessions',
            'framework/views',
        ].map((path) => mkdir(`${instance.dir}/${path}`, { recursive: true })),
    );

    await tinker(instance, CREATE_DATABASE, {
        E2E_DB_NAME: instance.database,
    });
    // chat:install:reset only runs when APP_ENV=local (it wipes the whole configured database).
    await artisan(instance, ['chat:install:reset', '--force'], {
        APP_ENV: 'local',
    });

    if (instance.kind === 'seeded') {
        if (instance.auth === 'pizzasys') {
            const portal = harnessSecrets();

            await tinker(instance, STORE_PIZZASYS_ANSWERS, {
                E2E_PORTAL_URL: portal.baseUrl,
                E2E_PORTAL_SERVICE: portal.service.name,
                E2E_PORTAL_TOKEN: portal.service.token,
            });
        } else {
            await tinker(instance, STORE_WIZARD_ANSWERS, {
                E2E_ADMIN_NAME: ADMIN.name,
                E2E_ADMIN_EMAIL: ADMIN.email,
                E2E_ADMIN_PASSWORD: ADMIN.password,
            });
        }
    }

    if (instance.kind === 'installed') {
        if (instance.auth === 'pizzasys') {
            await installWithPortal(instance);
        } else {
            await installWithCli(instance);
        }

        if (instance.seed !== null) {
            await seedStaff(instance);
        }
    }
}

/** P3 test data (`seed: 'staff'`): staff accounts, more categories, who serves what. */
async function seedStaff(instance: Instance): Promise<void> {
    await tinker(instance, SEED_P3_STAFF, {
        E2E_P3_CATEGORIES: JSON.stringify(P3_CATEGORIES),
        E2E_P3_STAFF_JSON: JSON.stringify([
            { ...SARA, serves: 'sara' },
            { ...TARIQ, serves: 'tariq' },
            ADMIN_ONLY,
        ]),
    });
}

/**
 * P3 `seed: 'demo'`: a fully configured, published widget for the read-only view scenarios (axe, 375px, RTL, screenshots):
 * domains of the host page, greetings with agent faces, every category, custom branding and texts, opening hours.
 */
async function seedDemoWidget(instance: Instance): Promise<void> {
    const context = await request.newContext({
        baseURL: instance.url,
        storageState: authStatePath(instance, 'admin'),
    });

    try {
        const api = new Api(context, instance.url);

        await createWidget(api, {
            name: 'Acme Storefront',
            domains: [`localhost:${instance.hostPort}`, 'shop.example.com'],
            categories: ['general', 'billing', 'sales', 'technical-support'],
            greetings: [
                {
                    body: 'Hi! Need a hand choosing the right pair?',
                    agent_name: 'Sara',
                    weight: 3,
                },
                {
                    body: 'Questions about an order? Ask me anything.',
                    agent_name: 'Omar',
                    weight: 2,
                },
                { body: 'Welcome back! Anything I can help with today?' },
            ],
            config: {
                theme: {
                    primary: '#2563eb',
                    accent: '#f59e0b',
                    radius: 12,
                    launcherSize: 'lg',
                },
                launcher: { style: 'pill', label: 'Talk to us' },
                texts: {
                    en: {
                        title: 'Acme support',
                        subtitle: 'We usually reply in a few minutes',
                        welcome: 'Hi! How can we help you today?',
                    },
                    ar: {
                        title: 'دعم أكمي',
                        welcome: 'مرحباً! كيف يمكننا مساعدتك؟',
                    },
                },
                greetings: { delaySeconds: 2, autoHideSeconds: 30 },
                hours: {
                    mode: 'auto_hours',
                    timezone: 'Asia/Kolkata',
                    schedule: [
                        { day: 1, start: '09:00', end: '17:00' },
                        { day: 2, start: '09:00', end: '17:00' },
                        { day: 3, start: '09:00', end: '17:00' },
                    ],
                    holidays: [{ date: '2027-01-01', label: 'New Year' }],
                },
            },
            settings: { timezone: 'Asia/Kolkata' },
        });
    } finally {
        await context.dispose();
    }
}

/** A real install through the non-interactive command in mode 2: the portal administrator's login is verified live. */
async function installWithPortal(instance: Instance): Promise<void> {
    const portal = harnessSecrets();

    await artisan(instance, ['chat:install', '--mode=pizzasys'], {
        APP_ENV: 'local',
        INSTALL_AUTH_BASE_URL: portal.baseUrl,
        INSTALL_AUTH_SERVICE_NAME: portal.service.name,
        INSTALL_AUTH_SERVICE_TOKEN: portal.service.token,
        INSTALL_AUTH_ADMIN_EMAIL: portalUsers().admin.email,
        INSTALL_AUTH_ADMIN_PASSWORD: portal.password,
        INSTALL_APP_NAME: 'PNE Chat',
        INSTALL_APP_URL: instance.url,
        INSTALL_LOCALE: instance.locale,
        INSTALL_TIMEZONE: 'UTC',
        INSTALL_IDLE_TIMEOUT_MINUTES: '120',
    });

    if (instance.testingEnvironment) {
        await tinker(
            instance,
            `\\App\\Models\\AuthEnvironment::query()->updateOrCreate(['key' => 'testing'], [
    'label' => 'Testing',
    'base_url' => (string) getenv('E2E_PORTAL_URL'),
    'service_name' => (string) getenv('E2E_PORTAL_SERVICE'),
    'service_token' => (string) getenv('E2E_PORTAL_TOKEN'),
    'verify_tls' => true,
]);`,
            {
                E2E_PORTAL_URL: portal.baseUrl,
                E2E_PORTAL_SERVICE: portal.other.name,
                E2E_PORTAL_TOKEN: portal.other.token,
            },
        );
    }
}

/** A real install through the non-interactive command, then the extra accounts. */
async function installWithCli(instance: Instance): Promise<void> {
    await artisan(instance, ['chat:install', '--mode=local'], {
        APP_ENV: 'local',
        INSTALL_ADMIN_NAME: ADMIN.name,
        INSTALL_ADMIN_EMAIL: ADMIN.email,
        INSTALL_ADMIN_PASSWORD: ADMIN.password,
        INSTALL_APP_NAME: 'PNE Chat',
        INSTALL_APP_URL: instance.url,
        INSTALL_LOCALE: instance.locale,
        INSTALL_TIMEZONE: 'UTC',
        INSTALL_IDLE_TIMEOUT_MINUTES: '120',
    });

    await tinker(instance, CREATE_USERS, {
        E2E_USERS_JSON: JSON.stringify(EXTRA_USERS),
    });
}

/** Log in once over HTTP and keep the session, so specs do not hit the login throttle. */
async function saveLogin(
    instance: Instance,
    user: Pick<TestUser, 'email' | 'password'>,
    role: Role,
): Promise<void> {
    const context = await request.newContext({ baseURL: instance.url });

    try {
        await context.get('/login');
        const state = await context.storageState();
        const xsrf = state.cookies.find(
            (cookie) => cookie.name === 'XSRF-TOKEN',
        );

        if (!xsrf) {
            throw new Error(`No XSRF cookie from ${instance.url}/login`);
        }

        const response = await context.post('/login', {
            headers: {
                Accept: 'application/json',
                'X-XSRF-TOKEN': decodeURIComponent(xsrf.value),
            },
            data: { email: user.email, password: user.password },
        });

        if (!response.ok()) {
            throw new Error(
                `Login as ${role} failed for ${instance.key}: HTTP ${response.status()} ${await response.text()}`,
            );
        }

        await context.storageState({ path: authStatePath(instance, role) });
    } finally {
        await context.dispose();
    }
}

/** The newest modification time under a directory (0 when it does not exist). */
async function newest(dir: string): Promise<number> {
    let latest = 0;

    try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;

            latest = Math.max(
                latest,
                entry.isDirectory()
                    ? await newest(path)
                    : (await stat(path)).mtimeMs,
            );
        }
    } catch {
        // missing directory
    }

    return latest;
}

async function modified(path: string): Promise<number> {
    try {
        return (await stat(path)).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * The specs drive the BUILT assets (`public/build`, `public/widget/v1/loader.js`, both git-ignored): build them when they
 * are missing or older than the sources, instead of failing with "Unable to locate file in Vite manifest" mid-run.
 */
async function ensureBuilt(): Promise<void> {
    const run = promisify(execFile);
    const jobs: [string, string, string[]][] = [
        [
            `${ROOT}public/build/manifest.json`,
            'build',
            ['resources/js', 'resources/css', 'resources/views'],
        ],
        [
            `${ROOT}public/widget/v1/loader.js`,
            'build:widget',
            ['resources/widget/src'],
        ],
    ];

    for (const [artifact, script, sources] of jobs) {
        const built = await modified(artifact);
        const sourceTimes = await Promise.all(
            sources.map((source) => newest(`${ROOT}${source}`)),
        );

        if (built === 0 || Math.max(...sourceTimes) > built) {
            console.log(`e2e: npm run ${script} (assets missing or stale)`);
            await run('npm', ['run', script], {
                cwd: ROOT,
                maxBuffer: 16 * 1024 * 1024,
                timeout: 300_000,
            });
        }
    }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
    await ensureBuilt();

    const needsHarness = ACTIVE_INSTANCES.some(
        (instance) => instance.auth === 'pizzasys',
    );
    let harnessStarted = false;
    const teardown = async (): Promise<void> => {
        if (harnessStarted) {
            harnessStarted = false;
            await stopHarness();
        }
    };

    try {
        if (needsHarness) {
            await bootHarness();
            harnessStarted = true;
            await ensureHarnessUsers();
        }

        await prepareAll();
    } catch (error) {
        await teardown();

        throw error;
    }

    return teardown;
}

async function prepareAll(): Promise<void> {
    const failures: string[] = [];

    await Promise.all(
        ACTIVE_INSTANCES.map(async (instance) => {
            try {
                await prepare(instance);
            } catch (error) {
                failures.push(
                    `[${instance.key}] ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }),
    );

    if (failures.length > 0) {
        throw new Error(`e2e setup failed:\n${failures.join('\n\n')}`);
    }

    // Saved sessions come last: they need the freshly installed servers (and run one at a time per user).
    for (const instance of ACTIVE_INSTANCES.filter(
        (item) => item.kind === 'installed',
    )) {
        if (instance.auth === 'pizzasys') {
            await saveLogin(instance, portalSessionUser('admin'), 'admin');
            await saveLogin(instance, portalSessionUser('agent'), 'agent');
        } else {
            await saveLogin(instance, ADMIN, 'admin');
            await saveLogin(instance, AGENT, 'agent');

            if (instance.seed !== null) {
                await saveLogin(instance, ADMIN_ONLY, 'admin-only');
            }

            if (instance.seed === 'demo') {
                await seedDemoWidget(instance);
            }
        }
    }
}
