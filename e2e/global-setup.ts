/**
 * Runs once before the suite. Resets every active scenario to a known state:
 *
 *   1. wipe the scenario's private storage directory (sessions, cache, logs, install state/lock);
 *   2. create the `chatfeature_e2e*` database if it does not exist yet;
 *   3. `chat:install:reset --force` (env-scoped, wipes ONLY that database);
 *   4. per kind: nothing (`fresh`), stored wizard answers (`seeded`), or a real
 *      `chat:install --mode=local` plus the extra test accounts and saved logins (`installed`).
 *
 * Note: Playwright starts the `webServer`s BEFORE `globalSetup`. That is fine because the
 * servers are only waited for on a static file (no Laravel boot) and the tests start after this
 * function returned.
 */
import { mkdir, rm } from 'node:fs/promises';
import { request } from '@playwright/test';
import { artisan, tinker } from './support/artisan';
import {
    ACTIVE_INSTANCES,
    assertSafe,
    type Instance,
} from './support/scenarios';
import {
    ADMIN,
    AGENT,
    authStatePath,
    EXTRA_USERS,
    type TestUser,
} from './support/users';

const CREATE_DATABASE = `
$name = (string) getenv('E2E_DB_NAME');
if (! preg_match('/^chatfeature_e2e[a-z_]*$/', $name)) { throw new RuntimeException('Unsafe database name: '.$name); }
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
        default => $factory->admin(),
    };
    if (! empty($user['unverified'])) { $factory = $factory->unverified(); }
    $factory->create(['name' => $user['name'], 'email' => $user['email'], 'password' => $user['password']]);
}
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
        await tinker(instance, STORE_WIZARD_ANSWERS, {
            E2E_ADMIN_NAME: ADMIN.name,
            E2E_ADMIN_EMAIL: ADMIN.email,
            E2E_ADMIN_PASSWORD: ADMIN.password,
        });
    }

    if (instance.kind === 'installed') {
        await installWithCli(instance);
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
    user: TestUser,
    role: 'admin' | 'agent',
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

export default async function globalSetup(): Promise<void> {
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
        await saveLogin(instance, ADMIN, 'admin');
        await saveLogin(instance, AGENT, 'agent');
    }
}
