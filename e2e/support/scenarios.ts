/**
 * The e2e scenarios: one throwaway Laravel server per scenario.
 *
 * The install wizard is stateful (it locks itself after the last step), so tests cannot share
 * one server. Every scenario below therefore owns a port, a MySQL database, a private storage
 * directory (sessions, cache, logs, compiled views and the install state/lock files) and its own
 * environment. Nothing here touches the developer's real `chatfeature` database: every database
 * name must start with `chatfeature_e2e` (enforced in `assertSafe`).
 *
 * Add a scenario: append it to `DEFINITIONS`, then point a spec at it with `test.use({ scenario: '<name>' })`. See docs/testing.md.
 *
 * Ports the suite owns (everything else belongs to other suites or running agents):
 *   web servers      8110-8129 (8120-8129: mode 2)   8230-8249 (P3)   8260-8279 (P4)
 *   customer sites   8240-8247 (P3)                  8280-8289 (P4)
 *   Reverb (P4)      8340-8348
 * P4 layout: a stateful scenario takes web `8260 + n` (desktop) and `8270 + n` (mobile twin), a customer site `8280 + n` / `8285 + n`
 * and Reverb `8340 + n` / `8345 + n`; `p4-chat` is n = 0, `p4-chat-views` n = 2, `p4-chat-views-rtl` n = 3. 8264-8269, 8274-8279,
 * 8284, 8289 and 8344/8348 are free for more P4 scenarios.
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
    | 'p3-limits'
    // P4 (live chat: real Reverb, the visitor panel, the agent inbox). Ports 8260-8279, 8280-8289, 8340-8349.
    | 'p4-chat'
    | 'p4-chat-views'
    | 'p4-chat-views-rtl';

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
        /** Scenarios with a Reverb server: the mobile project's own Reverb port. */
        mobileReverbPort?: number;
    };
    /**
     * Test data created right after the install (see `SEED_P3` in global-setup.ts): `staff` adds the staff accounts and
     * three more categories, `demo` additionally a fully configured, published widget "Acme Storefront" (with domains,
     * greetings and categories). P4's `chat`: the administrator, the agents Alice (Billing + General) and Bob (Sales + General),
     * the categories Billing / Sales / General and a published, enabled "Acme Storefront" that may run on the scenario's customer site
     * (`SEED_P4` in global-setup.ts, constants in `e2e/support/chat-seed.ts`).
     */
    seed?: 'staff' | 'demo' | 'chat';
    /**
     * Port of a tiny static "customer site" (e2e/support/host-server.mjs) on ANOTHER origin than the app
     * (`http://localhost:<port>` vs `http://127.0.0.1:<app port>`): the cross-origin embed tests drive it.
     */
    hostPort?: number;
    /**
     * Port of a real Reverb server (`php artisan reverb:start`, started by Playwright's `webServer` next to the app) the instance
     * publishes to and the visitor panel connects to. The instance then runs with `BROADCAST_CONNECTION=reverb`; the queue stays
     * `sync` (docs/testing.md, "Realtime and the queue").
     */
    reverbPort?: number;
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
    // P4: the live chat. A real Reverb per instance, the `chat` seed (admin, Alice, Bob, three categories, the widget "Acme Storefront"),
    // the customer site on another origin. Stateful: its own server per project.
    'p4-chat': {
        kind: 'installed',
        port: 8260,
        dbSuffix: '_p4_chat',
        mode: 'local',
        seed: 'chat',
        hostPort: 8280,
        reverbPort: 8340,
        // Chat starts are limited per client network (3 a minute per widget): the browsers of the specs each present an own address
        // through X-Forwarded-For (`Actors.visitor()`), which the server only believes when it trusts the proxy.
        env: { TRUSTED_PROXIES: '*' },
        perProject: {
            mobilePort: 8270,
            mobileDbSuffix: '_p4_chat_mobile',
            mobileHostPort: 8285,
            mobileReverbPort: 8345,
        },
    },
    // Read-only views of the chat (axe, 375px, RTL): shared by both projects, nothing may change state that others rely on.
    'p4-chat-views': {
        kind: 'installed',
        port: 8262,
        dbSuffix: '_p4_chat_views',
        mode: 'local',
        seed: 'chat',
        hostPort: 8282,
        reverbPort: 8342,
        env: { TRUSTED_PROXIES: '*' },
    },
    'p4-chat-views-rtl': {
        kind: 'installed',
        port: 8263,
        dbSuffix: '_p4_chat_views_rtl',
        mode: 'local',
        locale: 'ar',
        seed: 'chat',
        hostPort: 8283,
        reverbPort: 8343,
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

/** Every P4 instance's Reverb app key (the secret and app id are per instance). The dashboard learns the address from the `realtime` shared prop at runtime. */
export const E2E_REVERB_KEY = 'e2e-reverb-key';

export type ReverbServer = {
    port: number;
    /** What clients connect to (the visitor panel gets it in the `ws` block of its session). */
    url: string;
    appId: string;
    /** The same for every instance (it is public and baked into the dashboard build); the secret is per instance. */
    key: string;
    secret: string;
};

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
    /** P3 / P4 test data (see `Definition.seed`). */
    seed: 'staff' | 'demo' | 'chat' | null;
    /** The cross-origin host page server (`http://localhost:<port>`), when the scenario has one. */
    hostPort: number | null;
    hostUrl: string | null;
    /** The instance's Reverb server (P4), or null: the app then broadcasts to nothing (`BROADCAST_CONNECTION=null`). */
    reverb: ReverbServer | null;
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
    reverbPort: number | null = definition.reverbPort ?? null,
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

    // A real Reverb for this instance: the app publishes to it (inline, the queue stays `sync`), the panel connects to it.
    const reverb: ReverbServer | null =
        reverbPort === null
            ? null
            : {
                  port: reverbPort,
                  url: `http://127.0.0.1:${reverbPort}`,
                  appId: String(reverbPort),
                  key: E2E_REVERB_KEY,
                  secret: `e2e-reverb-secret-${reverbPort}`,
              };

    if (reverb !== null) {
        Object.assign(env, {
            BROADCAST_CONNECTION: 'reverb',
            REVERB_APP_ID: reverb.appId,
            REVERB_APP_KEY: reverb.key,
            REVERB_APP_SECRET: reverb.secret,
            // The public address clients use, and the one the Reverb process binds to: the same here (no proxy in between).
            REVERB_HOST: '127.0.0.1',
            REVERB_PORT: String(reverb.port),
            REVERB_SCHEME: 'http',
            REVERB_SERVER_HOST: '127.0.0.1',
            REVERB_SERVER_PORT: String(reverb.port),
            // The panel's iframe is served by the app (127.0.0.1) so the app host is allowed anyway; the customer site is listed too.
            ...(hostPort === null
                ? {}
                : { REVERB_ALLOWED_ORIGINS: 'localhost' }),
        });
    }

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
        reverb,
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
                    definition.perProject.mobileReverbPort ??
                        definition.reverbPort ??
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
