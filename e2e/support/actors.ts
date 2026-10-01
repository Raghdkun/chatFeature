/**
 * Several people in ONE test, each in a browser context of their own (own cookies, own storage, own sockets): a visitor on the
 * customer site, agent Alice, agent Bob, the administrator. The `actors` fixture of `e2e/support/test.ts` builds them:
 *
 *   test.use({ scenario: 'p4-chat' });
 *   test('...', async ({ actors, instance }) => {
 *       const alice = await actors.staff('alice', { presence: 'online', open: '/inbox' });
 *       const visitor = await actors.visitor();
 *       const panel = await openCustomerSite(visitor.page, instance, { open: true });
 *       ...
 *   });
 *
 * Staff start from the saved login of the scenario (cookie session, no login throttle; `signInApi` / `signInUi` make fresh sessions),
 * their dashboard connects to the instance's Reverb from the `realtime` shared prop, and every actor is watched for page errors,
 * console errors, failed requests and 5xx answers (`watch.ts`): the fixture fails the test about them when it ends unless a spec
 * allowed them (`actor.watch.allow(...)`).
 */
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { Api } from './api';
import { clientAddress, StaffApi, type PresenceStatus } from './chat-api';
import { Inbox } from './inbox';
import type { Instance } from './scenarios';
import {
    ADMIN,
    ALICE,
    authStatePath,
    BOB,
    type Role,
    type TestUser,
} from './users';
import { watchContext, type Allowed, type Watch } from './watch';

export type StaffName = 'alice' | 'bob' | 'admin';

const STAFF: Record<StaffName, { user: TestUser; role: Role }> = {
    alice: { user: ALICE, role: 'alice' },
    bob: { user: BOB, role: 'bob' },
    admin: { user: ADMIN, role: 'admin' },
};

type DeviceOptions = {
    /** `project` (default): the viewport / user agent of the running project (desktop 1280x800, mobile Pixel 7). `desktop`: always 1280x800. */
    device?: 'project' | 'desktop';
};

/** What the actor's context takes over from the running Playwright project (`devices['Pixel 7']` in the mobile project). */
function contextOptions(testInfo: TestInfo, device: DeviceOptions['device']) {
    if (device === 'desktop') {
        return { viewport: { width: 1280, height: 800 } };
    }

    const use = testInfo.project.use;

    return {
        viewport: use.viewport ?? { width: 1280, height: 800 },
        userAgent: use.userAgent,
        deviceScaleFactor: use.deviceScaleFactor,
        isMobile: use.isMobile,
        hasTouch: use.hasTouch,
    };
}

/**
 * Signs a staff user in through the dashboard's login endpoint (Fortify, JSON) and returns the cookie-holding context's API.
 * `address` is the client address the server should see (`X-Forwarded-For`, believed by the scenarios that trust the proxy): the
 * login limiter also counts per address (30 a minute), which one machine running many specs at once would use up.
 */
export async function signInApi(
    context: BrowserContext,
    instance: Instance,
    user: Pick<TestUser, 'email' | 'password'>,
    address?: string,
): Promise<Api> {
    const forwarded =
        address === undefined ? {} : { 'X-Forwarded-For': address };

    await context.request.get(`${instance.url}/login`, { headers: forwarded });

    const state = await context.storageState();
    const xsrf = state.cookies.find((cookie) => cookie.name === 'XSRF-TOKEN');
    const response = await context.request.post(`${instance.url}/login`, {
        headers: {
            Accept: 'application/json',
            'X-XSRF-TOKEN': decodeURIComponent(xsrf?.value ?? ''),
            ...forwarded,
        },
        data: { email: user.email, password: user.password },
        failOnStatusCode: false,
    });

    if (!response.ok()) {
        throw new Error(
            `Signing in as ${user.email} failed: HTTP ${response.status()} ${await response.text()}`,
        );
    }

    return new Api(context.request, instance.url);
}

/** Signs in through the real login form (for specs about the form itself; it is throttled to 5 attempts a minute per account). */
export async function signInUi(
    page: Page,
    user: Pick<TestUser, 'email' | 'password'>,
): Promise<void> {
    await page.goto('/login');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(user.password);
    await page.locator('[data-test="login-button"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

class Actor {
    constructor(
        readonly name: string,
        readonly context: BrowserContext,
        readonly page: Page,
        readonly watch: Watch,
    ) {}

    /** Open a second page in the same context (a second tab of the same person). */
    newPage(): Promise<Page> {
        return this.context.newPage();
    }

    async close(): Promise<void> {
        await this.context.close().catch(() => undefined);
    }
}

export class StaffActor extends Actor {
    readonly api: StaffApi;
    readonly inbox: Inbox;
    private beat: ReturnType<typeof setInterval> | null = null;

    constructor(
        name: string,
        readonly user: TestUser,
        context: BrowserContext,
        page: Page,
        watch: Watch,
        instance: Instance,
    ) {
        super(name, context, page, watch);
        this.api = new StaffApi(new Api(context.request, instance.url));
        this.inbox = new Inbox(page);
    }

    /** Sets the presence through the management API (`online` / `away` count as a heartbeat). */
    async setPresence(status: PresenceStatus): Promise<void> {
        const result = await this.api.setPresence(status);

        if (!result.ok) {
            throw new Error(
                `${this.name}: setting presence ${status} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
            );
        }
    }

    /**
     * Keeps the presence fresh for a spec that does not keep the inbox open (routing counts an agent as reachable for 90 s after the
     * last heartbeat, and the open inbox beats every 30 s by itself). Beats every `everyMs` until the actor is closed.
     */
    keepAlive(everyMs = 20_000): void {
        if (this.beat !== null) {
            return;
        }

        this.beat = setInterval(() => {
            void this.api.heartbeat().catch(() => undefined);
        }, everyMs);
    }

    async close(): Promise<void> {
        if (this.beat !== null) {
            clearInterval(this.beat);
            this.beat = null;
        }

        await super.close();
    }
}

export class VisitorActor extends Actor {
    /** The client address this browser presents to the server (`X-Forwarded-For`): its own rate-limit bucket. */
    constructor(
        name: string,
        context: BrowserContext,
        page: Page,
        watch: Watch,
        readonly address: string,
    ) {
        super(name, context, page, watch);
    }
}

export type StaffOptions = DeviceOptions & {
    /** Set the presence right away (`online` | `away` | `offline`); default: leave it as it is (offline after the install). */
    presence?: PresenceStatus;
    /** Open this dashboard path right away (`'/inbox'`); the inbox waits for its shell. */
    open?: string;
    /** Start the heartbeat (see `StaffActor.keepAlive`). */
    keepAlive?: boolean;
    allow?: Allowed;
};

export class Actors {
    private readonly all: Actor[] = [];

    constructor(
        private readonly browser: Browser,
        private readonly instance: Instance,
        private readonly testInfo: TestInfo,
    ) {}

    /** A staff member in a browser context of their own, signed in with the scenario's saved login. */
    async staff(
        who: StaffName,
        options: StaffOptions = {},
    ): Promise<StaffActor> {
        const { user, role } = STAFF[who];
        const context = await this.browser.newContext({
            ...contextOptions(this.testInfo, options.device),
            baseURL: this.instance.url,
            storageState: authStatePath(this.instance, role),
        });

        return this.finishStaff(who, user, context, options);
    }

    /**
     * A staff member a spec created (`createTeam()` in chat-flows.ts) and who has no saved login: a fresh browser context signed in
     * through the login endpoint (the form is throttled to 5 attempts a minute per account: one sign-in per account and test).
     */
    async staffLogin(
        user: TestUser,
        options: StaffOptions = {},
    ): Promise<StaffActor> {
        const context = await this.browser.newContext({
            ...contextOptions(this.testInfo, options.device),
            baseURL: this.instance.url,
            storageState: { cookies: [], origins: [] },
        });

        await signInApi(context, this.instance, user, clientAddress());

        return this.finishStaff(user.name, user, context, options);
    }

    private async finishStaff(
        name: string,
        user: TestUser,
        context: BrowserContext,
        options: StaffOptions,
    ): Promise<StaffActor> {
        const page = await context.newPage();
        const watch = watchContext(context, name, options.allow);
        const actor = new StaffActor(
            name,
            user,
            context,
            page,
            watch,
            this.instance,
        );

        this.all.push(actor);

        if (options.presence) {
            await actor.setPresence(options.presence);
        }

        if (options.keepAlive) {
            actor.keepAlive();
        }

        if (options.open) {
            if (options.open === '/inbox') {
                await actor.inbox.goto();
            } else {
                await page.goto(options.open);
            }
        }

        return actor;
    }

    /**
     * A visitor's browser: no login, its own storage (so its own visitor), and its own network address for the server's per-address
     * rate limits (`X-Forwarded-For` added to every request to the app; the P4 servers trust it). Load the customer site in
     * `actor.page` with `openCustomerSite()`.
     */
    async visitor(
        options: DeviceOptions & {
            allow?: Allowed;
            name?: string;
            /** The browser's language (`navigator.language`): the widget answers in it when it has texts for it. Default: Arabic in an Arabic scenario, else Chrome's `en-US`. */
            locale?: string;
        } = {},
    ): Promise<VisitorActor> {
        const address = clientAddress();
        const context = await this.browser.newContext({
            ...contextOptions(this.testInfo, options.device),
            ...(options.locale === undefined && this.instance.locale === 'ar'
                ? { locale: 'ar' }
                : { locale: options.locale }),
            storageState: { cookies: [], origins: [] },
        });

        // Added after the browser's CORS decision (a request header set here does not make the call "non-simple").
        await context.route(`${this.instance.url}/**`, (route) =>
            route.continue({
                headers: {
                    ...route.request().headers(),
                    'x-forwarded-for': address,
                },
            }),
        );

        const page = await context.newPage();
        const name = options.name ?? 'visitor';
        const watch = watchContext(context, name, options.allow);
        const actor = new VisitorActor(name, context, page, watch, address);

        this.all.push(actor);

        return actor;
    }

    /** Problems every actor's watch found so far (see `watch.ts`). */
    problems(): string[] {
        return this.all.flatMap((actor) => actor.watch.problems);
    }

    async closeAll(): Promise<void> {
        await Promise.all(this.all.splice(0).map((actor) => actor.close()));
    }
}
