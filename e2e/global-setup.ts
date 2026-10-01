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
 * P4 (`seed: 'chat'`): the agents Alice and Bob, the categories and the widget "Acme Storefront" are created (`SEED_P4`) and what was
 * created is written to `<instance dir>/seed.json` (e2e/support/chat-seed.ts). The Reverb servers of those scenarios are `webServer`s
 * too, so they are already listening while the databases are prepared. The dashboard build is made with the e2e Reverb address
 * (`ensureBuilt`).
 *
 * Note: Playwright starts the `webServer`s BEFORE `globalSetup`. That is fine because the
 * servers are only waited for on a static file (no Laravel boot) and the tests start after this
 * function returned.
 */
import { execFile } from 'node:child_process';
import {
    readdir,
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { request } from '@playwright/test';
import { artisan, tinker } from './support/artisan';
import {
    ACTIVE_INSTANCES,
    assertSafe,
    DASHBOARD_REVERB,
    ROOT,
    type Instance,
} from './support/scenarios';
import {
    seedPath,
    SEED_ROUTING,
    SEED_WIDGET_NAME,
    type ChatSeed,
} from './support/chat-seed';
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
    ALICE,
    authStatePath,
    BOB,
    EXTRA_USERS,
    P3_CATEGORIES,
    P4_CATEGORIES,
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
 * `seed: 'staff'` (P3) and `seed: 'chat'` (P4): the staff accounts and the categories (General comes from the installer, so it is
 * only updated). `E2E_CATEGORIES` lists `servedBy` names, `E2E_STAFF_JSON` the accounts with the name they `serve` under. P3: Sara serves
 * Billing + Sales, Tariq Technical support; P4: Alice Billing + General, Bob Sales + General; everybody else nothing. Prints the
 * user ids as JSON (`{"<email>": id}`) on the last line.
 */
const SEED_STAFF = `
foreach (json_decode((string) getenv('E2E_CATEGORIES'), true) as $position => $row) {
    \\App\\Models\\Category::query()->updateOrCreate(['slug' => $row['slug']], [
        'name' => $row['name'], 'icon' => $row['icon'], 'color' => $row['color'], 'sort_order' => $position + 1, 'is_active' => true,
    ]);
}
$served = [];
foreach (json_decode((string) getenv('E2E_CATEGORIES'), true) as $row) {
    foreach ($row['servedBy'] as $who) { $served[$who][] = $row['slug']; }
}
$ids = [];
foreach (json_decode((string) getenv('E2E_STAFF_JSON'), true) as $user) {
    $factory = \\App\\Models\\User::factory();
    $factory = match ($user['kind']) {
        'admin-only' => $factory->admin()->state(['is_agent' => false]),
        default => $factory->agent(),
    };
    $model = $factory->create(['name' => $user['name'], 'email' => $user['email'], 'password' => $user['password']]);
    $ids[$user['email']] = $model->id;
    $who = $user['serves'] ?? null;
    if ($who !== null) {
        $ulids = \\App\\Models\\Category::query()->whereIn('slug', $served[$who] ?? [])->pluck('ulid')->all();
        app(\\App\\Domain\\Catalog\\Actions\\SyncUserCategories::class)->handle($model, $ulids, $model);
    }
}
if (getenv('E2E_ADMIN_EMAIL')) {
    $ids[(string) getenv('E2E_ADMIN_EMAIL')] = \\App\\Models\\User::query()->where('email', getenv('E2E_ADMIN_EMAIL'))->value('id');
}
echo "\\nE2E_IDS=".json_encode($ids)."\\n";
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

        if (instance.seed === 'chat') {
            await seedChatStaff(instance);
        } else if (instance.seed !== null) {
            await seedStaff(instance);
        }
    }
}

/** P3 test data (`seed: 'staff'`): staff accounts, more categories, who serves what. */
async function seedStaff(instance: Instance): Promise<void> {
    await tinker(instance, SEED_STAFF, {
        E2E_CATEGORIES: JSON.stringify(P3_CATEGORIES),
        E2E_STAFF_JSON: JSON.stringify([
            { ...SARA, serves: 'sara' },
            { ...TARIQ, serves: 'tariq' },
            ADMIN_ONLY,
        ]),
    });
}

/** The user ids a staff seed printed (`E2E_IDS={"<email>": id}`). */
function seededIds(output: string): Record<string, number> {
    const line = output.split('\n').find((row) => row.startsWith('E2E_IDS='));

    if (!line) {
        throw new Error(`The staff seed printed no ids:\n${output}`);
    }

    return JSON.parse(line.slice('E2E_IDS='.length));
}

/** The user ids of the P4 staff, kept for `seedChatWidget` (which writes `seed.json`). */
const chatUserIds = new Map<string, ChatSeed['users']>();

/** P4 `seed: 'chat'`: Alice (Billing + General), Bob (Sales + General), the three categories. */
async function seedChatStaff(instance: Instance): Promise<void> {
    const output = await tinker(instance, SEED_STAFF, {
        E2E_CATEGORIES: JSON.stringify(P4_CATEGORIES),
        E2E_STAFF_JSON: JSON.stringify([
            { ...ALICE, serves: 'alice' },
            { ...BOB, serves: 'bob' },
        ]),
        E2E_ADMIN_EMAIL: ADMIN.email,
    });
    const ids = seededIds(output);

    chatUserIds.set(instance.key, {
        admin: ids[ADMIN.email],
        alice: ids[ALICE.email],
        bob: ids[BOB.email],
    });
}

/**
 * P4 `seed: 'chat'`: the published, enabled widget "Acme Storefront" for the instance's customer site: open around the clock, General +
 * Billing + Sales, the routing of `SEED_ROUTING`. The queue timeout and the opening mode are sent as settings AND inside the draft
 * config: publishing copies the config's values back over the columns. Writes `seed.json` next to the instance's state.
 */
async function seedChatWidget(instance: Instance): Promise<void> {
    const context = await request.newContext({
        baseURL: instance.url,
        storageState: authStatePath(instance, 'admin'),
    });

    try {
        const api = new Api(context, instance.url);
        const widget = await createWidget(api, {
            name: SEED_WIDGET_NAME,
            domains: [`localhost:${instance.hostPort}`],
            categories: P4_CATEGORIES.map((category) => category.slug),
            settings: {
                offline_mode: 'always_online',
                queue_timeout_seconds: SEED_ROUTING.queueTimeoutSeconds,
            },
            config: {
                hours: { mode: 'always_online' },
                routing: SEED_ROUTING,
                // A greeting popup would cover the launcher the specs click.
                greetings: { enabled: false },
            },
        });
        const categories = (await api.ok('GET', '/api/v1/categories')).data as {
            ulid: string;
            slug: string;
            name: string;
        }[];
        const category = (slug: string) => {
            const found = categories.find((item) => item.slug === slug);

            if (!found) {
                throw new Error(`Seed category "${slug}" is missing.`);
            }

            return { ulid: found.ulid, name: found.name };
        };
        const seed: ChatSeed = {
            widget: {
                ulid: widget.ulid,
                key: widget.key,
                name: SEED_WIDGET_NAME,
            },
            categories: {
                general: category('general'),
                billing: category('billing'),
                sales: category('sales'),
            },
            users: chatUserIds.get(instance.key)!,
        };

        await writeFile(seedPath(instance), JSON.stringify(seed, null, 2));
    } finally {
        await context.dispose();
    }
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
 * The dashboard's Echo reads its Reverb address from `VITE_REVERB_*` AT BUILD TIME. The e2e build therefore bakes in the e2e address
 * (`DASHBOARD_REVERB`: a fixed key, and a port nothing listens on) whatever the developer's `.env` says, and the suite relays the
 * staff sockets to the instance's own Reverb (`relayStaffSockets()` in e2e/support/realtime.ts). A build made with another address
 * (a plain `npm run build` with a dev `.env`) is rebuilt.
 */
async function builtForE2e(): Promise<boolean> {
    const baked = (name: string, value: string | number) =>
        new RegExp(`${name}:\\s*["'\`]${value}["'\`]`);
    const wanted = [
        baked('VITE_REVERB_APP_KEY', DASHBOARD_REVERB.key),
        baked('VITE_REVERB_HOST', DASHBOARD_REVERB.host),
        baked('VITE_REVERB_PORT', DASHBOARD_REVERB.port),
    ];

    try {
        const assets = `${ROOT}public/build/assets`;

        for (const file of await readdir(assets)) {
            if (!file.endsWith('.js')) {
                continue;
            }

            const code = await readFile(`${assets}/${file}`, 'utf8');

            if (wanted.every((pattern) => pattern.test(code))) {
                return true;
            }
        }
    } catch {
        // no build yet
    }

    return false;
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
        const wrongReverb = script === 'build' && !(await builtForE2e());

        if (built === 0 || Math.max(...sourceTimes) > built || wrongReverb) {
            console.log(
                `e2e: npm run ${script} (${wrongReverb ? 'built for another Reverb address' : 'assets missing or stale'})`,
            );
            await run('npm', ['run', script], {
                cwd: ROOT,
                // The process environment wins over `.env` for `VITE_*` variables.
                env: {
                    ...process.env,
                    VITE_REVERB_APP_KEY: DASHBOARD_REVERB.key,
                    VITE_REVERB_HOST: DASHBOARD_REVERB.host,
                    VITE_REVERB_PORT: String(DASHBOARD_REVERB.port),
                    VITE_REVERB_SCHEME: DASHBOARD_REVERB.scheme,
                },
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

            if (instance.seed === 'chat') {
                await saveLogin(instance, ALICE, 'alice');
                await saveLogin(instance, BOB, 'bob');
                await seedChatWidget(instance);
            } else if (instance.seed !== null) {
                await saveLogin(instance, ADMIN_ONLY, 'admin-only');
            }

            if (instance.seed === 'demo') {
                await seedDemoWidget(instance);
            }
        }
    }
}
