/**
 * The e2e scenarios: one throwaway Laravel server per scenario.
 *
 * The install wizard is stateful (it locks itself after the last step), so tests cannot share
 * one server. Every scenario below therefore owns a port, a MySQL database, a private storage
 * directory (sessions, cache, logs, compiled views and the install state/lock files) and its own
 * environment. Nothing here touches the developer's real `chatfeature` database: every database
 * name must start with `chatfeature_e2e` (enforced in `assertSafe`).
 *
 * Add a scenario: append it to `DEFINITIONS` (the suite owns ports 8110-8129 and 8230-8249; 8120-8129 are the mode-2 ones, 8230-8249 the P3 ones), then point a spec at it
 * with `test.use({ scenario: '<name>' })`. See docs/testing.md.
 */
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** How a scenario's database/state is prepared before the run. */
export type ScenarioKind =
    /** Empty database, no install state: the wizard starts from scratch. */
    | 'fresh'
    /** Wizard answers (mode, admin, basics) are stored, nothing is installed: every screen can be opened read-only. */
    | 'seeded'
    /** `php artisan chat:install --mode=local` already ran; the lock exists. */
    | 'installed';

export type ScenarioName =
    | 'fresh-local'
    | 'fresh-token'
    | 'installed'
    | 'wizard-views'
    | 'wizard-views-rtl'
    | 'installed-rtl'
    | 'shots-desktop'
    | 'shots-mobile'
    // Mode 2 (Auth Portal / pizzasys): these need the local pizzasys harness (e2e/support/harness.ts).
    | 'fresh-pizzasys'
    | 'installed-pizzasys'
    | 'settings-pizzasys'
    | 'wizard-views-pizzasys'
    | 'wizard-views-pizzasys-rtl'
    | 'installed-pizzasys-rtl'
    // P3 (catalog, agents, widgets, the real loader on a cross-origin host page). Ports 8230-8249.
    | 'p3-categories'
    | 'p3-agents'
    | 'p3-widgets'
    | 'p3-host'
    | 'p3-views'
    | 'p3-views-rtl'
    | 'p3-limits';

export type ProjectName = 'desktop' | 'mobile' | 'pizzasys-outage';

type Definition = {
    kind: ScenarioKind;
    port: number;
    /** Suffix appended to `chatfeature_e2e`. */
    dbSuffix: string;
    /** `local` skips the setup token; `token` runs as APP_ENV=testing with APP_INSTALLED=false and a SETUP_TOKEN. */
    mode: 'local' | 'token';
    /** UI locale (APP_LOCALE before install, INSTALL_LOCALE for installed scenarios). */
    locale?: 'en' | 'ar';
    /** Stateful scenarios get a second instance (own port/database) for the `mobile` project. */
    perProject?: {
        mobilePort: number;
        mobileDbSuffix: string;
        /** Scenarios with a host page server: the mobile project's own host port. */
        mobileHostPort?: number;
    };
    /**
     * Test data created right after the install (see `SEED_P3` in global-setup.ts): `staff` adds the staff accounts and
     * three more categories, `demo` additionally a fully configured, published widget "Acme Storefront" (with domains,
     * greetings and categories).
     */
    seed?: 'staff' | 'demo';
    /**
     * Port of a tiny static "customer site" (e2e/support/host-server.mjs) on ANOTHER origin than the app
     * (`http://localhost:<port>` vs `http://127.0.0.1:<app port>`): the cross-origin embed tests drive it.
     */
    hostPort?: number;
    /** Extra environment of the instance's server and artisan calls (after the defaults). */
    env?: Record<string, string>;
    /** Only started when E2E_SCREENSHOTS=1. */
    screenshotsOnly?: boolean;
    /**
     * `pizzasys` scenarios talk to the local pizzasys harness: `installed` ones are installed with
     * `chat:install --mode=pizzasys`, `seeded` ones get mode-2 wizard answers, `fresh` ones start the
     * wizard from scratch (the spec picks the Auth Portal itself).
     */
    auth?: 'local' | 'pizzasys';
    /**
     * Mode 2 only: a configured Testing environment next to Production (the `other-svc` service client of the
     * harness), so Settings > Auth can offer the environment switch. Read-only scenarios use it.
     */
    testingEnvironment?: boolean;
};

const DEFINITIONS: Record<ScenarioName, Definition> = {
    'fresh-local': {
        kind: 'fresh',
        port: 8110,
        dbSuffix: '',
        mode: 'local',
        perProject: { mobilePort: 8116, mobileDbSuffix: '_mobile' },
    },
    'fresh-token': {
        kind: 'fresh',
        port: 8111,
        dbSuffix: '_token',
        mode: 'token',
        perProject: { mobilePort: 8117, mobileDbSuffix: '_token_mobile' },
    },
    installed: {
        kind: 'installed',
        port: 8112,
        dbSuffix: '_installed',
        mode: 'local',
    },
    'wizard-views': {
        kind: 'seeded',
        port: 8113,
        dbSuffix: '_views',
        mode: 'local',
    },
    'wizard-views-rtl': {
        kind: 'seeded',
        port: 8114,
        dbSuffix: '_views_rtl',
        mode: 'local',
        locale: 'ar',
    },
    'installed-rtl': {
        kind: 'installed',
        port: 8115,
        dbSuffix: '_installed_rtl',
        mode: 'local',
        locale: 'ar',
    },
    // Mode 2 (Auth Portal). Ports 8120-8129 belong to these.
    'fresh-pizzasys': {
        kind: 'fresh',
        port: 8120,
        dbSuffix: '_pz_fresh',
        mode: 'local',
        auth: 'pizzasys',
        perProject: { mobilePort: 8121, mobileDbSuffix: '_pz_fresh_mobile' },
    },
    'installed-pizzasys': {
        kind: 'installed',
        port: 8122,
        dbSuffix: '_pz_installed',
        mode: 'local',
        auth: 'pizzasys',
        testingEnvironment: true,
        perProject: {
            mobilePort: 8123,
            mobileDbSuffix: '_pz_installed_mobile',
        },
    },
    // Settings > Auth writes (edits environments, switches the active one): its own server per project.
    'settings-pizzasys': {
        kind: 'installed',
        port: 8124,
        dbSuffix: '_pz_settings',
        mode: 'local',
        auth: 'pizzasys',
        perProject: { mobilePort: 8125, mobileDbSuffix: '_pz_settings_mobile' },
    },
    'wizard-views-pizzasys': {
        kind: 'seeded',
        port: 8126,
        dbSuffix: '_pz_views',
        mode: 'local',
        auth: 'pizzasys',
    },
    'wizard-views-pizzasys-rtl': {
        kind: 'seeded',
        port: 8127,
        dbSuffix: '_pz_views_rtl',
        mode: 'local',
        locale: 'ar',
        auth: 'pizzasys',
    },
    'installed-pizzasys-rtl': {
        kind: 'installed',
        port: 8128,
        dbSuffix: '_pz_installed_rtl',
        mode: 'local',
        locale: 'ar',
        auth: 'pizzasys',
        testingEnvironment: true,
    },
    // P3. Mutating specs get their own server per project; the read-only ones (axe, 375px, RTL, screenshots) share one.
    'p3-categories': {
        kind: 'installed',
        port: 8230,
        dbSuffix: '_p3_categories',
        mode: 'local',
        seed: 'staff',
        perProject: {
            mobilePort: 8231,
            mobileDbSuffix: '_p3_categories_mobile',
        },
    },
    'p3-agents': {
        kind: 'installed',
        port: 8232,
        dbSuffix: '_p3_agents',
        mode: 'local',
        seed: 'staff',
        perProject: { mobilePort: 8233, mobileDbSuffix: '_p3_agents_mobile' },
    },
    // Widget list + builder + preview (admin UI): every test creates its own widgets.
    'p3-widgets': {
        kind: 'installed',
        port: 8234,
        dbSuffix: '_p3_widgets',
        mode: 'local',
        seed: 'staff',
        hostPort: 8240,
        perProject: {
            mobilePort: 8235,
            mobileDbSuffix: '_p3_widgets_mobile',
            mobileHostPort: 8241,
        },
    },
    // The real loader on a cross-origin host page.
    'p3-host': {
        kind: 'installed',
        port: 8236,
        dbSuffix: '_p3_host',
        mode: 'local',
        seed: 'staff',
        hostPort: 8242,
        perProject: {
            mobilePort: 8237,
            mobileDbSuffix: '_p3_host_mobile',
            mobileHostPort: 8243,
        },
    },
    'p3-views': {
        kind: 'installed',
        port: 8238,
        dbSuffix: '_p3_views',
        mode: 'local',
        seed: 'demo',
        hostPort: 8244,
    },
    'p3-views-rtl': {
        kind: 'installed',
        port: 8239,
        dbSuffix: '_p3_views_rtl',
        mode: 'local',
        locale: 'ar',
        seed: 'demo',
        hostPort: 8245,
    },
    // Hammered on purpose (rate limits of the public endpoints are per client address, so it must not share a server).
    'p3-limits': {
        kind: 'installed',
        port: 8246,
        dbSuffix: '_p3_limits',
        mode: 'local',
        seed: 'staff',
        hostPort: 8247,
        // The limits are per client address: trust X-Forwarded-For so every test can be its own "client" (a retry or a repeat
        // never meets the budget an earlier attempt spent).
        env: { TRUSTED_PROXIES: '*' },
    },
    // Real wizard runs, in token mode, that the screenshot spec walks through for the deck.
    'shots-desktop': {
        kind: 'fresh',
        port: 8118,
        dbSuffix: '_shots',
        mode: 'token',
        screenshotsOnly: true,
    },
    'shots-mobile': {
        kind: 'fresh',
        port: 8119,
        dbSuffix: '_shots_mobile',
        mode: 'token',
        screenshotsOnly: true,
    },
};

/** The one-time setup token of every `token` scenario. Test-only value. */
export const SETUP_TOKEN = 'e2e-setup-token';

/** Deterministic, test-only APP_KEY so the suite does not depend on the developer's `.env`. */
const APP_KEY = `base64:${Buffer.from('pne-chat-e2e-test-key-0123456789').toString('base64')}`;

export type Instance = {
    /** Unique key; `fresh-local` for desktop, `fresh-local-mobile` for the mobile project. */
    key: string;
    scenario: ScenarioName;
    kind: ScenarioKind;
    mode: Definition['mode'];
    locale: 'en' | 'ar';
    port: number;
    url: string;
    database: string;
    /** Private storage directory (LARAVEL_STORAGE_PATH). */
    dir: string;
    /** Install state + lock files. */
    stateDir: string;
    /** Directory with the saved login sessions (installed scenarios). */
    authDir: string;
    screenshotsOnly: boolean;
    /** Signs people in through the local pizzasys harness (mode 2). */
    auth: 'local' | 'pizzasys';
    /** Mode 2: a Testing environment is configured next to Production. */
    testingEnvironment: boolean;
    /** P3 test data (see `Definition.seed`). */
    seed: 'staff' | 'demo' | null;
    /** The cross-origin host page server (`http://localhost:<port>`), when the scenario has one. */
    hostPort: number | null;
    hostUrl: string | null;
    /** Environment shared by the web server and every artisan call made for this instance. */
    env: Record<string, string>;
};

function build(
    scenario: ScenarioName,
    definition: Definition,
    key: string,
    port: number,
    dbSuffix: string,
    hostPort: number | null = definition.hostPort ?? null,
): Instance {
    const url = `http://127.0.0.1:${port}`;
    const dir = `${ROOT}storage/e2e-${key}`;
    const locale = definition.locale ?? 'en';
    const database = `chatfeature_e2e${dbSuffix}`;

    const env: Record<string, string> = {
        APP_ENV: definition.mode === 'token' ? 'testing' : 'local',
        APP_DEBUG: process.env.E2E_DEBUG ? 'true' : 'false',
        APP_NAME: 'PNE Chat',
        APP_URL: url,
        APP_KEY,
        APP_LOCALE: locale,
        APP_FALLBACK_LOCALE: 'en',
        BCRYPT_ROUNDS: '4',
        DB_CONNECTION: 'mysql',
        DB_DATABASE: database,
        SESSION_DRIVER: 'file',
        CACHE_STORE: 'file',
        QUEUE_CONNECTION: 'sync',
        BROADCAST_CONNECTION: 'null',
        MAIL_MAILER: 'log',
        LARAVEL_STORAGE_PATH: dir,
        INSTALL_STATE_DIR: `${dir}/state`,
        // The PHP built-in server is single threaded unless it gets workers: page + asset
        // requests would serialize otherwise.
        PHP_CLI_SERVER_WORKERS: '4',
    };

    Object.assign(env, definition.env ?? {});

    if (definition.mode === 'token') {
        env.APP_INSTALLED = 'false';
        env.SETUP_TOKEN = SETUP_TOKEN;
    }

    return {
        key,
        scenario,
        kind: definition.kind,
        mode: definition.mode,
        locale,
        port,
        url,
        database,
        dir,
        stateDir: `${dir}/state`,
        authDir: `${dir}/auth`,
        screenshotsOnly: definition.screenshotsOnly === true,
        auth: definition.auth ?? 'local',
        testingEnvironment: definition.testingEnvironment === true,
        seed: definition.seed ?? null,
        hostPort,
        hostUrl: hostPort === null ? null : `http://localhost:${hostPort}`,
        env,
    };
}

function expand(): Instance[] {
    const instances: Instance[] = [];

    for (const [name, definition] of Object.entries(DEFINITIONS) as [
        ScenarioName,
        Definition,
    ][]) {
        instances.push(
            build(name, definition, name, definition.port, definition.dbSuffix),
        );

        if (definition.perProject) {
            instances.push(
                build(
                    name,
                    definition,
                    `${name}-mobile`,
                    definition.perProject.mobilePort,
                    definition.perProject.mobileDbSuffix,
                    definition.perProject.mobileHostPort ??
                        definition.hostPort ??
                        null,
                ),
            );
        }
    }

    return instances;
}

/** Every instance, including the screenshot-only ones. */
export const ALL_INSTANCES: readonly Instance[] = expand();

/**
 * The instances this run needs: screenshot scenarios only with E2E_SCREENSHOTS=1, and
 * E2E_ONLY=installed,fresh-token limits a run to some scenarios (handy while writing a spec), and
 * E2E_SKIP_PIZZASYS=1 leaves out every mode-2 scenario (use it with `--grep-invert @pizzasys`).
 */
const only = (process.env.E2E_ONLY ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

export const ACTIVE_INSTANCES: readonly Instance[] = ALL_INSTANCES.filter(
    (instance) =>
        (!instance.screenshotsOnly || process.env.E2E_SCREENSHOTS === '1') &&
        // No pizzasys harness on this machine: leave the mode-2 scenarios (and the harness) out.
        (instance.auth !== 'pizzasys' ||
            process.env.E2E_SKIP_PIZZASYS !== '1') &&
        (only.length === 0 ||
            only.includes(instance.key) ||
            only.includes(instance.scenario)),
);

/**
 * The instance a spec talks to: stateful scenarios have one instance per project, the others
 * are shared by both projects.
 */
export function instanceFor(scenario: ScenarioName, project: string): Instance {
    const suffix = project === 'mobile' ? '-mobile' : '';
    const instance =
        ALL_INSTANCES.find((item) => item.key === `${scenario}${suffix}`) ??
        ALL_INSTANCES.find((item) => item.key === scenario);

    if (!instance) {
        throw new Error(`Unknown e2e scenario "${scenario}".`);
    }

    return instance;
}

/**
 * Safety net for everything destructive (wipe, install, rm): only ever act on databases and
 * directories that belong to the e2e suite.
 */
export function assertSafe(instance: Instance): void {
    if (!/^chatfeature_e2e[a-z0-9_]*$/.test(instance.database)) {
        throw new Error(
            `Refusing to touch database "${instance.database}": e2e databases must be named chatfeature_e2e*.`,
        );
    }

    if (instance.env.DB_DATABASE !== instance.database) {
        throw new Error(
            `Scenario ${instance.key} has an inconsistent DB_DATABASE.`,
        );
    }

    if (!instance.dir.startsWith(`${ROOT}storage/e2e-`)) {
        throw new Error(
            `Refusing to use "${instance.dir}": e2e state lives in storage/e2e-*.`,
        );
    }
}
