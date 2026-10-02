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
 *   web servers      8110-8129 (8120-8129: mode 2)   8230-8249 (P3)   8260-8279 (P4)   8380-8387 (P5)
 *   customer sites   8240-8247 (P3)                  8280-8289, 8292-8293 (P4; `p4-poll`: 8291 / 8296)   8390-8397 (P5)
 *   Reverb (P4)      8340-8348, 8350-8351 (`p4-staff`: 8344 / 8348)   8400-8406 (P5)
 *   P5 spare         web 8388-8389, Reverb 8407-8408; 8398 / 8399 are the fake push services of `p5-notify` (desktop / mobile: an HTTP proxy
 *                    for fcm.googleapis.com, started by the specs, not by Playwright); 8409 is nothing on purpose (`p5-presence-failover` points its Redis there)
 *   P6 (WhatsApp)    8360-8379: `p6-wa` web 8360 / 8361, customer site 8362 / 8363, Reverb 8364 / 8365, mock OpenWA 8366 / 8367 (desktop / mobile);
 *                    `p6-wa-rtl` (the Arabic twin, E2) web 8369 / 8370, customer site 8371 / 8372, Reverb 8373 / 8374, mock OpenWA 8375 / 8376;
 *                    8368 (scripts/openwa-record.mjs's webhook receiver) and 8377-8379 (the mock's own test) are not for scenarios
 * P4 layout: a stateful scenario takes web `8260 + n` (desktop) and `8270 + n` (mobile twin), a customer site `8280 + n` / `8285 + n`
 * and Reverb `8340 + n` / `8345 + n`; `p4-chat` is n = 0, `p4-chat-views` n = 2, `p4-chat-views-rtl` n = 3. 8264-8269, 8274-8279,
 * 8284, 8289 and 8344/8348 are free for more P4 scenarios. The deck-screenshot scenario `p4-shots` (n = 6) uses 8266 / 8276, customer
 * sites 8292 / 8293 and Reverb 8350 / 8351.
 */
import { createECDH, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensurePushTrust, PUSH_TRUST_DIR } from './push-trust';

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
    | 'p4-chat-views-rtl'
    | 'p4-shots'
    // P4 staff side (E2): the inbox, the permission matrices and the realtime resilience specs.
    | 'p4-staff'
    | 'p4-poll'
    // P6 (WhatsApp via OpenWA, tested against the stateful mock `e2e/support/openwa-mock.mjs`). Ports 8360-8379.
    | 'p6-wa'
    | 'p6-wa-rtl'
    // P5 (presence, notifications, the launcher alert). Ports 8380-8409, see the comment at the top.
    | 'p5-chat'
    | 'p5-presence-redis'
    | 'p5-presence-failover'
    | 'p5-notify'
    | 'p5-notify-rtl';

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
        /** Scenarios with a mock OpenWA: the mobile project's own mock port. */
        mobileOpenWaPort?: number;
        /** Scenarios with `push`: the mobile project's own fake push service port. */
        mobilePushPort?: number;
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
    /**
     * Port of the stateful OpenWA mock (`e2e/support/openwa-mock.mjs`, started by Playwright's `webServer` next to the app). The seed points the
     * app at it (`whatsapp.openwa.base_url` / `whatsapp.openwa.api_key` settings, `whatsapp.enabled`), so the app's real HTTP client talks to the
     * mock; the mock delivers its signed webhooks to the app's `/webhooks/openwa/{session}` route. The instance needs `PORTAL_ALLOW_PRIVATE_HOSTS=true`
     * (loopback address) and `TRUSTED_PROXIES=*`, see `env`.
     */
    openWaPort?: number;
    /** Extra environment of the instance's server and artisan calls (after the defaults). */
    env?: Record<string, string>;
    /**
     * P5: the presence store is REDIS (`PRESENCE_STORE=redis`, phpredis) on the machine's local Redis, in its own database index with a key
     * prefix of the instance's port (`e2e-p5-<port>-`); the specs and the setup only ever touch that prefix (never FLUSHALL / FLUSHDB).
     */
    redisDb?: number;
    /**
     * P5: web push is configured (VAPID keys derived from a fixed seed, see `vapidKeys()`), and the server reaches the push vendor only
     * through the suite's fake push service (an HTTP proxy for `fcm.googleapis.com` it trusts through `PHPRC`, e2e/support/push-trust.ts). A
     * never-asked agent then gets the first-login dialog on the dashboard.
     * `port` is where the specs start the fake push service (`perProject.mobilePushPort` for the mobile twin); none: the scenario never sends.
     */
    push?: { port?: number };
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
    // The deck screenshots of the live chat (`screenshots/p4.spec.ts`, E2E_SCREENSHOTS=1 only): the `chat` seed, one stateful instance per
    // viewport (`p4-shots` for the desktop pictures, `p4-shots-mobile` for the phone ones, so both can run at the same time).
    'p4-shots': {
        kind: 'installed',
        port: 8266,
        dbSuffix: '_p4_shots',
        mode: 'local',
        seed: 'chat',
        hostPort: 8292,
        reverbPort: 8350,
        env: { TRUSTED_PROXIES: '*' },
        screenshotsOnly: true,
        perProject: {
            mobilePort: 8276,
            mobileDbSuffix: '_p4_shots_mobile',
            mobileHostPort: 8293,
            mobileReverbPort: 8351,
        },
    },
    // P4 staff side (E2): `p4-staff` is the staff inbox / permissions / realtime-resilience scenario (real Reverb, n = 4); `p4-poll` is the
    // same installed chat instance WITHOUT any websocket server (`BROADCAST_CONNECTION=null`: both sides run on REST polling). Their ports
    // (the customer site of `p4-poll` sits at 8291 / 8296) were assigned to this block by the orchestrator.
    'p4-staff': {
        kind: 'installed',
        port: 8264,
        dbSuffix: '_p4_staff',
        mode: 'local',
        seed: 'chat',
        hostPort: 8284,
        reverbPort: 8344,
        env: { TRUSTED_PROXIES: '*' },
        perProject: {
            mobilePort: 8274,
            mobileDbSuffix: '_p4_staff_mobile',
            mobileHostPort: 8289,
            mobileReverbPort: 8348,
        },
    },
    'p4-poll': {
        kind: 'installed',
        port: 8265,
        dbSuffix: '_p4_poll',
        mode: 'local',
        seed: 'chat',
        hostPort: 8291,
        env: { TRUSTED_PROXIES: '*' },
        perProject: {
            mobilePort: 8275,
            mobileDbSuffix: '_p4_poll_mobile',
            mobileHostPort: 8296,
        },
    },
    // P6: WhatsApp. The `chat` seed (admin, Alice, Bob, categories, the widget "Acme Storefront"), a real Reverb, the customer site, and the OpenWA mock
    // the app is configured to use. Stateful: its own server (and mock) per project. Everything WhatsApp is admin-only (agents get 403).
    'p6-wa': {
        kind: 'installed',
        port: 8360,
        dbSuffix: '_p6_wa',
        mode: 'local',
        seed: 'chat',
        hostPort: 8362,
        reverbPort: 8364,
        openWaPort: 8366,
        // PORTAL_ALLOW_PRIVATE_HOSTS: the OpenWA address is a loopback one (the base-URL rule only accepts it with this switch or APP_ENV=local).
        env: {
            TRUSTED_PROXIES: '*',
            PORTAL_ALLOW_PRIVATE_HOSTS: 'true',
            // The flood spec trips the per-network webhook limit: a low one keeps it cheap (production default 6000 a minute).
            WHATSAPP_WEBHOOK_RATE_PER_NETWORK: '600',
        },
        perProject: {
            mobilePort: 8361,
            mobileDbSuffix: '_p6_wa_mobile',
            mobileHostPort: 8363,
            mobileReverbPort: 8365,
            mobileOpenWaPort: 8367,
        },
    },
    // P5: presence, notifications and the launcher alert (specs in e2e/p5). Every scenario has the `chat` seed, a customer site and, unless
    // noted, a real Reverb. None of the P4 scenarios has VAPID keys (`push` is null: no first-login dialog), so the P4 specs are unaffected.
    // `p5-chat`: the DATABASE presence store (the P4 default of the suite), the launcher alert chain and the presence screens; every test works in
    // a world of its own (`createWorld`) because presence, queues and capacity are global to a scenario.
    'p5-chat': {
        kind: 'installed',
        port: 8380,
        dbSuffix: '_p5_chat',
        mode: 'local',
        seed: 'chat',
        hostPort: 8390,
        reverbPort: 8400,
        env: { TRUSTED_PROXIES: '*' },
        perProject: {
            mobilePort: 8381,
            mobileDbSuffix: '_p5_chat_mobile',
            mobileHostPort: 8391,
            mobileReverbPort: 8401,
        },
    },
    // The same presence rules on the REDIS store (the real Redis on 127.0.0.1:6379, database 13, prefix `e2e-p5-<port>-`).
    'p5-presence-redis': {
        kind: 'installed',
        port: 8382,
        dbSuffix: '_p5_presence_redis',
        mode: 'local',
        seed: 'chat',
        hostPort: 8392,
        reverbPort: 8402,
        redisDb: 13,
        env: { TRUSTED_PROXIES: '*' },
        perProject: {
            mobilePort: 8383,
            mobileDbSuffix: '_p5_presence_redis_mobile',
            mobileHostPort: 8393,
            mobileReverbPort: 8403,
        },
    },
    // Redis is configured but nothing listens there (8409 is nobody's): the database store answers, one warning is logged. No Reverb: the
    // dashboard runs on REST polling, which is all this scenario needs. One instance for both projects (every test has its own world).
    'p5-presence-failover': {
        kind: 'installed',
        port: 8384,
        dbSuffix: '_p5_presence_failover',
        mode: 'local',
        seed: 'chat',
        hostPort: 8394,
        env: {
            TRUSTED_PROXIES: '*',
            PRESENCE_STORE: 'redis',
            REDIS_CLIENT: 'phpredis',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: '8409',
        },
    },
    // Web push is configured: VAPID keys, a fake push service the specs start (https, trusted by the server's PHP), the first-login dialog for
    // never-asked staff, Settings > Notifications with a real "this browser" section. Sound / push settings are per user: worlds again.
    'p5-notify': {
        kind: 'installed',
        port: 8385,
        dbSuffix: '_p5_notify',
        mode: 'local',
        seed: 'chat',
        hostPort: 8395,
        reverbPort: 8404,
        push: { port: 8398 },
        env: { TRUSTED_PROXIES: '*' },
        perProject: {
            mobilePort: 8386,
            mobileDbSuffix: '_p5_notify_mobile',
            mobileHostPort: 8396,
            mobileReverbPort: 8405,
            mobilePushPort: 8399,
        },
    },
    // Arabic / right-to-left: Settings > Notifications, the first-login dialog, the agents page and the inbox, mirrored. One instance for both projects.
    'p5-notify-rtl': {
        kind: 'installed',
        port: 8387,
        dbSuffix: '_p5_notify_rtl',
        mode: 'local',
        locale: 'ar',
        seed: 'chat',
        hostPort: 8397,
        reverbPort: 8406,
        push: {},
        env: { TRUSTED_PROXIES: '*' },
    },
    // P6 e2e (E2): the Arabic twin of `p6-wa` (administrator UI mirrored, widget in Arabic): only the layout / RTL specs of `whatsapp/views-rtl.spec.ts`.
    'p6-wa-rtl': {
        kind: 'installed',
        port: 8369,
        dbSuffix: '_p6_wa_rtl',
        mode: 'local',
        locale: 'ar',
        seed: 'chat',
        hostPort: 8371,
        reverbPort: 8373,
        openWaPort: 8375,
        env: {
            TRUSTED_PROXIES: '*',
            PORTAL_ALLOW_PRIVATE_HOSTS: 'true',
            // The flood spec trips the per-network webhook limit: a low one keeps it cheap (production default 6000 a minute).
            WHATSAPP_WEBHOOK_RATE_PER_NETWORK: '600',
        },
        perProject: {
            mobilePort: 8370,
            mobileDbSuffix: '_p6_wa_rtl_mobile',
            mobileHostPort: 8372,
            mobileReverbPort: 8374,
            mobileOpenWaPort: 8376,
        },
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

/**
 * The VAPID key pair of every `push` scenario, derived from a fixed seed so nothing secret is committed and every run (and every process of
 * a run) agrees: the private key is a SHA-256 of the seed (a valid P-256 scalar), the public key its uncompressed point; both URL-safe
 * base64 without padding, the format `minishlink/web-push` and `pushManager.subscribe({ applicationServerKey })` use. Test-only values.
 */
export function vapidKeys(): { publicKey: string; privateKey: string } {
    const ecdh = createECDH('prime256v1');

    ecdh.setPrivateKey(
        createHash('sha256').update('pne-chat-e2e-vapid-seed').digest(),
    );

    return {
        publicKey: ecdh.getPublicKey().toString('base64url'),
        privateKey: ecdh.getPrivateKey().toString('base64url'),
    };
}

export type ReverbServer = {
    port: number;
    /** What clients connect to (the visitor panel gets it in the `ws` block of its session). */
    url: string;
    appId: string;
    /** The same for every instance (it is public and baked into the dashboard build); the secret is per instance. */
    key: string;
    secret: string;
};

export type OpenWaServer = {
    port: number;
    /** What the app is configured with (`whatsapp.openwa.base_url`) and what specs drive (`/__mock/*`). */
    url: string;
    /** The mock's admin API key (a test value, the app stores it as `whatsapp.openwa.api_key`). */
    apiKey: string;
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
    /** The instance's OpenWA mock (P6), or null. */
    openWa: OpenWaServer | null;
    /** P5: the presence store is Redis: its database index and the key prefix this instance (and nobody else) uses. */
    redis: { db: number; prefix: string } | null;
    /** P5: web push is configured (VAPID keys, the server trusts the fake push service); `port` is where the specs start that service. */
    push: { port: number | null } | null;
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
    openWaPort: number | null = definition.openWaPort ?? null,
    pushPort: number | null = definition.push?.port ?? null,
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
        // P5: no web push and the table as the presence store unless a scenario says otherwise (`.env` must not leak VAPID keys in: a
        // never-asked agent would get the first-login dialog on top of every P4 flow).
        VAPID_PUBLIC_KEY: '',
        VAPID_PRIVATE_KEY: '',
        PRESENCE_STORE: 'database',
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

    // P5: the presence state in Redis, in the suite's own database index under a prefix of this instance's port (phpredis, as the product needs).
    const redis =
        definition.redisDb === undefined
            ? null
            : { db: definition.redisDb, prefix: `e2e-p5-${port}-` };

    if (redis !== null) {
        Object.assign(env, {
            PRESENCE_STORE: 'redis',
            REDIS_CLIENT: 'phpredis',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: '6379',
            REDIS_DB: String(redis.db),
            REDIS_PREFIX: redis.prefix,
        });
    }

    // P5: web push on (the first-login dialog, Settings > Notifications). The endpoints of the specs' subscriptions are a PUBLIC vendor host
    // (`https://fcm.googleapis.com/...`, which is all the product's endpoint guard accepts), and this instance's HTTP client reaches the
    // internet only through the fake push service on `pushPort`, which is an HTTP proxy for that one host (push.ts); nothing else it calls
    // (Reverb, itself) goes through it. Where nothing listens (no service running, or a scenario without a port: 8409 is nobody's) a push is
    // refused at the connection: a failed delivery, and never a request to the real vendor. The server trusts the service's certificate through
    // its own `php.ini` (`PHPRC`, push-trust.ts).
    if (definition.push !== undefined) {
        const keys = vapidKeys();

        Object.assign(env, {
            VAPID_PUBLIC_KEY: keys.publicKey,
            VAPID_PRIVATE_KEY: keys.privateKey,
            VAPID_SUBJECT: 'mailto:e2e@example.test',
            PHPRC: PUSH_TRUST_DIR,
            HTTPS_PROXY: `http://127.0.0.1:${pushPort ?? 8409}`,
            NO_PROXY: '127.0.0.1,localhost,::1',
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
        openWa:
            openWaPort === null
                ? null
                : {
                      port: openWaPort,
                      url: `http://127.0.0.1:${openWaPort}`,
                      apiKey: `owa_k1_e2e-mock-key-${openWaPort}`,
                  },
        redis,
        push: definition.push === undefined ? null : { port: pushPort },
        env,
    };
}

/**
 * Moves instances to other ports (and databases): `E2E_PORT_MAP='{"p4-staff":{"port":8380,"hostPort":8390,"reverbPort":8400,"dbSuffix":"_x_staff"},
 * "p4-staff-mobile":{...}}'` (keys are instance keys, every field optional). For running a scenario while its own ports (and database, the
 * name is the same on every checkout of the machine) belong to another run: give it a `dbSuffix` of its own too. The state directory is
 * per checkout already (`storage/e2e-<key>`).
 */
type PortMap = Record<
    string,
    {
        port?: number;
        hostPort?: number;
        reverbPort?: number;
        openWaPort?: number;
        pushPort?: number;
        dbSuffix?: string;
    }
>;

const PORT_MAP: PortMap = JSON.parse(process.env.E2E_PORT_MAP ?? '{}');

function expand(): Instance[] {
    const instances: Instance[] = [];
    const place = (
        name: ScenarioName,
        definition: Definition,
        key: string,
        ports: {
            port: number;
            dbSuffix: string;
            hostPort?: number;
            reverbPort?: number;
            openWaPort?: number;
            pushPort?: number;
        },
    ): Instance => {
        const moved = PORT_MAP[key] ?? {};

        return build(
            name,
            definition,
            key,
            moved.port ?? ports.port,
            moved.dbSuffix ?? ports.dbSuffix,
            moved.hostPort ?? ports.hostPort ?? null,
            moved.reverbPort ?? ports.reverbPort ?? null,
            moved.openWaPort ?? ports.openWaPort ?? null,
            moved.pushPort ?? ports.pushPort ?? null,
        );
    };

    for (const [name, definition] of Object.entries(DEFINITIONS) as [
        ScenarioName,
        Definition,
    ][]) {
        instances.push(
            place(name, definition, name, {
                port: definition.port,
                dbSuffix: definition.dbSuffix,
                hostPort: definition.hostPort,
                reverbPort: definition.reverbPort,
                openWaPort: definition.openWaPort,
                pushPort: definition.push?.port,
            }),
        );

        if (definition.perProject) {
            instances.push(
                place(name, definition, `${name}-mobile`, {
                    port: definition.perProject.mobilePort,
                    dbSuffix: definition.perProject.mobileDbSuffix,
                    hostPort:
                        definition.perProject.mobileHostPort ??
                        definition.hostPort,
                    reverbPort:
                        definition.perProject.mobileReverbPort ??
                        definition.reverbPort,
                    openWaPort:
                        definition.perProject.mobileOpenWaPort ??
                        definition.openWaPort,
                    pushPort:
                        definition.perProject.mobilePushPort ??
                        definition.push?.port,
                }),
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

// The servers read their php.ini when they start, so the fake push service's trust files must exist before Playwright starts them.
if (ACTIVE_INSTANCES.some((instance) => instance.push !== null)) {
    ensurePushTrust();
}

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
