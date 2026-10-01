/**
 * The "lab" of the P4 view specs (accessibility, phone layouts, RTL, keyboard, performance, screenshots): isolated test data for ONE
 * test in a scenario that both Playwright projects (and several spec files) share.
 *
 * Why: the seeded agents Alice and Bob are shared by everything that runs on a scenario, so an "empty inbox" or an offer count is
 * never certain, and an agent's capacity (5 live chats) is a shared pool. A `Tenant` is created through the management API in about a
 * second and belongs to the test alone: its own categories, its own agents (who serve only those categories), its own published
 * widget on the scenario's customer site (so a brand colour, texts or opening hours can differ per test). Nothing in a tenant is
 * ever offered to Alice or Bob, and nobody else is ever offered a tenant's chat.
 *
 *   test.use({ scenario: 'p4-chat-views' });
 *   test('...', async ({ lab, instance }) => {
 *       const tenant = await lab.tenant({ agents: 2 });
 *       const agent = await lab.agent(tenant, 0, { open: '/inbox' });
 *       const visitor = await lab.visitor();
 *       const panel = await openCustomerSite(visitor.page, instance, { key: tenant.widget.key, open: true });
 *       ...
 *   });
 *
 * Also here: chat setup without a browser (`lab.chat()` starts a chat as a visitor over the public API, `lab.accept()` claims it as an
 * agent), image uploads (`png()`, `uploadAsVisitor()`, `uploadAsStaff()`) and the axe scans of the dashboard and of the panel.
 */
import { deflateSync, crc32 } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import {
    type BrowserContext,
    type Frame,
    type Locator,
    type Page,
    type TestInfo,
} from '@playwright/test';
import { Api, createWidget } from './api';
import {
    StaffActor,
    type Actors,
    type StaffOptions,
    type VisitorActor,
} from './actors';
import { clientAddress, must, VisitorApi, clientMsgId } from './chat-api';
import { settleWidget } from './host';
import { setTheme } from './helpers';
import { openCustomerSite, type Panel } from './panel';
import type { Instance } from './scenarios';
import { expect, test as base } from './test';
import { PASSWORD, type TestUser } from './users';
import { watchContext } from './watch';

export type TenantAgent = TestUser & { id: number };

export type Tenant = {
    widget: { ulid: string; key: string; name: string };
    categories: { ulid: string; slug: string; name: string }[];
    /** Agents who serve every category of the tenant (the first one is "the" agent of most tests). */
    agents: TenantAgent[];
    admin: Api;
};

export type TenantOptions = {
    /** Agents who serve the tenant's categories (default 1). */
    agents?: 1 | 2 | 3;
    /** Categories the widget offers (default 1; a visitor with a single topic skips the topic screen). */
    categories?: 1 | 2 | 3;
    /** Merged into the widget's draft config (`theme`, `texts`, `features`, `preChat`, `hours`, ...) before it is published. */
    config?: Record<string, unknown>;
    /** Widget settings (`locale`, `offline_mode`, `queue_timeout_seconds`, ...). */
    settings?: Record<string, unknown>;
    /** The widget's name (default: a unique one). */
    name?: string;
    /** Names for the categories, in order (default: Billing, Sales, General plus a unique suffix). */
    categoryNames?: string[];
    /** Names for the agents, in order (default: unique ones). */
    agentNames?: string[];
};

const suffix = (): string => Math.random().toString(36).slice(2, 6);

const CATEGORY_NAMES = ['Billing', 'Sales', 'Technical support'];
const AGENT_NAMES = ['Alice Carter', 'Bob Mitchell', 'Carla Duarte'];

function phone(testInfo: TestInfo, device: 'project' | 'desktop' | undefined) {
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

export type Scene = {
    ulid: string;
    ticketNo: string;
    visitor: VisitorApi;
};

export class Lab {
    private readonly staff: StaffActor[] = [];
    private readonly apis: VisitorApi[] = [];

    constructor(
        private readonly instance: Instance,
        private readonly testInfo: TestInfo,
        private readonly newBrowserContext: (
            options: Parameters<
                import('@playwright/test').Browser['newContext']
            >[0],
        ) => Promise<BrowserContext>,
        private readonly admin: Api,
        private readonly visitors: Actors['visitor'],
    ) {}

    /** A visitor's browser (see `Actors.visitor`). */
    visitor(
        options: Parameters<Actors['visitor']>[0] = {},
    ): Promise<VisitorActor> {
        return this.visitors(options);
    }

    /** Creates the test's categories, agents and widget through the management API. */
    async tenant(options: TenantOptions = {}): Promise<Tenant> {
        const tag = suffix();
        const categoryCount = options.categories ?? 1;
        const agentCount = options.agents ?? 1;
        const categories: Tenant['categories'] = [];

        for (let index = 0; index < categoryCount; index += 1) {
            const base =
                options.categoryNames?.[index] ?? CATEGORY_NAMES[index];
            const name = options.categoryNames ? base : `${base} ${tag}`;
            const created = must<{ ulid: string; slug: string; name: string }>(
                await this.admin.post('/api/v1/categories', {
                    name,
                    icon: ['credit-card', 'shopping-cart', 'wrench'][index],
                    color: ['#2563eb', '#d97706', '#7c3aed'][index],
                    sort_order: 100 + index,
                }),
                'creating a category',
            );

            categories.push({
                ulid: created.ulid,
                slug: created.slug,
                name: created.name,
            });
        }

        const agents: TenantAgent[] = [];

        for (let index = 0; index < agentCount; index += 1) {
            const name =
                options.agentNames?.[index] ?? `${AGENT_NAMES[index]} ${tag}`;
            const email = `lab.${tag}.${index}@example.test`;
            const created = must<{ id: number }>(
                await this.admin.post('/api/v1/agents', {
                    name,
                    email,
                    password: PASSWORD,
                    is_agent: true,
                    category_ulids: categories.map((category) => category.ulid),
                }),
                'creating an agent',
            );

            agents.push({
                name,
                email,
                password: PASSWORD,
                kind: 'agent',
                id: created.id,
            });
        }

        const widgetName = options.name ?? `Lab widget ${tag}`;
        const widget = await createWidget(this.admin, {
            name: widgetName,
            domains: [`localhost:${this.instance.hostPort}`],
            categories: categories.map((category) => category.slug),
            settings: {
                offline_mode: 'always_online',
                queue_timeout_seconds: 45,
                ...(this.instance.locale === 'en'
                    ? {}
                    : { locale: this.instance.locale }),
                ...options.settings,
            },
            config: mergeConfig(
                {
                    ...(this.instance.locale === 'en'
                        ? {}
                        : { defaultLocale: this.instance.locale }),
                    hours: { mode: 'always_online' },
                    routing: {
                        waves: [{ afterSeconds: 0, statuses: ['online'] }],
                        wakeOfflineViaPush: false,
                        queueTimeoutSeconds: 45,
                    },
                    // A greeting popup would cover the launcher.
                    greetings: { enabled: false },
                },
                options.config ?? {},
            ),
        });

        return {
            widget: { ulid: widget.ulid, key: widget.key, name: widgetName },
            categories,
            agents,
            admin: this.admin,
        };
    }

    /** One of the tenant's agents in a browser of their own, signed in through the login endpoint (a fresh session). */
    async agent(
        tenant: Tenant,
        index = 0,
        options: Pick<StaffOptions, 'presence' | 'open' | 'device'> & {
            keepAlive?: boolean;
            colorScheme?: 'light' | 'dark';
            reducedMotion?: 'reduce' | 'no-preference';
            locale?: string;
            viewport?: { width: number; height: number };
        } = {},
    ): Promise<StaffActor> {
        const user = tenant.agents[index];
        const context = await this.newBrowserContext({
            ...phone(this.testInfo, options.device),
            ...(options.viewport ? { viewport: options.viewport } : {}),
            baseURL: this.instance.url,
            storageState: { cookies: [], origins: [] },
            ...(options.colorScheme
                ? { colorScheme: options.colorScheme }
                : {}),
            ...(options.reducedMotion
                ? { reducedMotion: options.reducedMotion }
                : {}),
            ...(options.locale ? { locale: options.locale } : {}),
        });

        await this.signIn(context, user);

        const page = await context.newPage();
        const watch = watchContext(context, `agent ${user.name}`);
        const actor = new StaffActor(
            'alice',
            user,
            context,
            page,
            watch,
            this.instance,
        );

        this.staff.push(actor);

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
     * Signs a tenant agent in from a network address of their own: the login form is limited to 30 attempts a minute per client address
     * (and the whole view suite signs dozens of agents in, in parallel, from one machine), and the P4 servers trust `X-Forwarded-For`.
     * The browser's own requests carry the same address, so the server sees one consistent person.
     */
    private async signIn(
        context: BrowserContext,
        user: TestUser,
    ): Promise<void> {
        const address = clientAddress();

        await context.route(`${this.instance.url}/**`, (route) =>
            route.continue({
                headers: {
                    ...route.request().headers(),
                    'x-forwarded-for': address,
                },
            }),
        );
        await context.request.get(`${this.instance.url}/login`, {
            headers: { 'X-Forwarded-For': address },
        });

        const state = await context.storageState();
        const xsrf = state.cookies.find(
            (cookie) => cookie.name === 'XSRF-TOKEN',
        );
        const response = await context.request.post(
            `${this.instance.url}/login`,
            {
                headers: {
                    Accept: 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(xsrf?.value ?? ''),
                    'X-Forwarded-For': address,
                },
                data: { email: user.email, password: user.password },
                failOnStatusCode: false,
            },
        );

        if (!response.ok()) {
            throw new Error(
                `Signing in as ${user.email} failed: HTTP ${response.status()} ${await response.text()}`,
            );
        }
    }

    /**
     * The scenario's administrator in a browser of their own (the saved login): for pages only an administrator has
     * (`/history`) and for the conversation of any agent.
     */
    async administrator(
        options: {
            open?: string;
            viewport?: { width: number; height: number };
        } = {},
    ): Promise<StaffActor> {
        const context = await this.newBrowserContext({
            ...phone(this.testInfo, 'project'),
            ...(options.viewport ? { viewport: options.viewport } : {}),
            baseURL: this.instance.url,
            storageState: `${this.instance.authDir}/admin.json`,
        });
        const page = await context.newPage();
        const watch = watchContext(context, 'administrator');
        const actor = new StaffActor(
            'admin',
            { name: 'Amira Hassan', email: '', password: '', kind: 'admin' },
            context,
            page,
            watch,
            this.instance,
        );

        this.staff.push(actor);

        if (options.open) {
            await page.goto(options.open);
        }

        return actor;
    }

    /** Starts a live chat as a visitor over the public API (no browser): the tenant's agents are offered it. */
    async chat(
        tenant: Tenant,
        options: {
            category?: number;
            name?: string;
            email?: string;
            message?: string;
        } = {},
    ): Promise<Scene> {
        const name = options.name ?? 'Maya Thompson';
        const visitor = await VisitorApi.start(this.instance, {
            key: tenant.widget.key,
            visitor: { name, email: options.email },
        });

        this.apis.push(visitor);

        const started = must<{ ulid: string; ticketNo: string }>(
            await visitor.startChat({
                category: tenant.categories[options.category ?? 0].slug,
                name,
                ...(options.email ? { email: options.email } : {}),
                ...(options.message ? { message: options.message } : {}),
            }),
            'starting a chat',
        );

        return { ulid: started.ulid, ticketNo: started.ticketNo, visitor };
    }

    /** An offline ticket left by a visitor over the public API (the form of the panel's `offline` state). */
    async ticket(
        tenant: Tenant,
        options: {
            category?: number;
            name?: string;
            email?: string;
            message?: string;
        } = {},
    ): Promise<Scene> {
        const name = options.name ?? 'Nadia Farouk';
        const visitor = await VisitorApi.start(this.instance, {
            key: tenant.widget.key,
        });

        this.apis.push(visitor);

        const created = must<{ ulid: string; ticketNo: string }>(
            await visitor.offlineTicket({
                name,
                email: options.email ?? 'nadia.farouk@example.org',
                message:
                    options.message ??
                    'Hello, my parcel has not arrived yet. Could you tell me when it will be delivered?',
                category: tenant.categories[options.category ?? 0].slug,
            }),
            'leaving an offline ticket',
        );

        return { ulid: created.ulid, ticketNo: created.ticketNo, visitor };
    }

    /** The agent accepts the chat through the API (what the Accept button does). */
    async accept(agent: StaffActor, scene: Pick<Scene, 'ulid'>): Promise<void> {
        must(await agent.api.claim(scene.ulid), `${agent.name} accepting`);
    }

    /**
     * A visitor's browser with the panel open on the customer site, a chat started through the panel's own screens and accepted by
     * `agent` (through the API): returns when the panel is `active`.
     */
    async activePanel(
        tenant: Tenant,
        agent: StaffActor,
        options: {
            name?: string;
            category?: number;
            device?: 'project' | 'desktop';
            locale?: string;
            site?: Partial<import('./panel').SiteOptions>;
        } = {},
    ): Promise<{ panel: Panel; visitor: VisitorActor; ulid: string }> {
        const visitor = await this.visitor({
            device: options.device,
            locale: options.locale,
        });
        const panel = await openCustomerSite(visitor.page, this.instance, {
            ...options.site,
            key: tenant.widget.key,
            open: true,
        });
        const chat = await panel.startChat({
            category: tenant.categories[options.category ?? 0].slug,
            name: options.name ?? 'Maya Thompson',
            email: 'maya.thompson@example.org',
        });

        expect(chat.ulid, 'the panel created a chat').not.toBeNull();
        await this.accept(agent, { ulid: chat.ulid! });
        await panel.expectState('active');

        return { panel, visitor, ulid: chat.ulid! };
    }

    /**
     * A chat that ran its whole course, for the history: accepted by `agent`, a short exchange, ended by the agent, then rated (`rating`
     * 1-5 with an optional comment) or skipped by the visitor (`rating: null`). Resolves once the chat is `closed`.
     */
    async finishedChat(
        tenant: Tenant,
        agent: StaffActor,
        options: {
            name: string;
            email?: string;
            category?: number;
            first: string;
            reply: string;
            rating: number | null;
            comment?: string;
        },
    ): Promise<Scene> {
        const scene = await this.chat(tenant, {
            name: options.name,
            email: options.email,
            category: options.category,
            message: options.first,
        });

        await this.accept(agent, scene);
        must(await agent.api.send(scene.ulid, options.reply), 'agent reply');
        must(await agent.api.end(scene.ulid), 'ending');

        if (options.rating === null) {
            must(await scene.visitor.skipRating(scene.ulid), 'skipping rating');
        } else {
            must(
                await scene.visitor.rate(
                    scene.ulid,
                    options.rating,
                    options.comment,
                ),
                'rating',
            );
        }

        return scene;
    }

    async dispose(): Promise<string[]> {
        const problems = this.staff.flatMap((actor) => actor.watch.problems);

        await Promise.all(this.staff.splice(0).map((actor) => actor.close()));
        await Promise.all(
            this.apis.splice(0).map((visitor) => visitor.dispose()),
        );

        return problems;
    }
}

/** Deep merge of plain objects (arrays and scalars of `over` replace). */
export function mergeConfig(
    base: Record<string, unknown>,
    over: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(over)) {
        const current = out[key];

        out[key] =
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            current !== null &&
            typeof current === 'object' &&
            !Array.isArray(current)
                ? mergeConfig(
                      current as Record<string, unknown>,
                      value as Record<string, unknown>,
                  )
                : value;
    }

    return out;
}

type Fixtures = { lab: Lab };

/** The `test` of the view specs: `test` of the suite plus the `lab` fixture (closed, and checked for page errors, when the test ends). */
export const test = base.extend<Fixtures>({
    lab: async ({ browser, instance, adminApi, actors }, use, testInfo) => {
        const lab = new Lab(
            instance,
            testInfo,
            (options) => browser.newContext(options),
            adminApi,
            (options) => actors.visitor(options),
        );

        await use(lab);

        const problems = await lab.dispose();

        if (
            testInfo.status === testInfo.expectedStatus &&
            problems.length > 0
        ) {
            throw new Error(
                `Unexpected errors in an agent's browser while the test ran:\n${problems.join('\n')}`,
            );
        }
    },
});

export { expect };

// ---------------------------------------------------------------------------------------------------------------------------------
// Images

/** A valid PNG of `width` x `height`; `paint(x, y)` returns [r, g, b] (default: a diagonal gradient). */
export function png(
    width = 320,
    height = 200,
    paint: (x: number, y: number) => [number, number, number] = (x, y) => [
        40 + Math.round((x / width) * 160),
        90 + Math.round((y / height) * 120),
        200 - Math.round(((x + y) / (width + height)) * 120),
    ],
): Buffer {
    const rows = Buffer.alloc((width * 3 + 1) * height);

    for (let y = 0; y < height; y += 1) {
        const offset = y * (width * 3 + 1);

        rows[offset] = 0;

        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = paint(x, y);

            rows[offset + 1 + x * 3] = r;
            rows[offset + 2 + x * 3] = g;
            rows[offset + 3 + x * 3] = b;
        }
    }

    const chunk = (type: string, data: Buffer): Buffer => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const length = Buffer.alloc(4);
        const check = Buffer.alloc(4);

        length.writeUInt32BE(data.length);
        check.writeUInt32BE(crc32(body) >>> 0);

        return Buffer.concat([length, body, check]);
    };
    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: RGB

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** Uploads an image to the visitor's conversation; returns the attachment (`ulid`, `url`, `thumbUrl`). */
export async function uploadAsVisitor(
    visitor: VisitorApi,
    ulid: string,
    file: Buffer,
    name = 'photo.png',
): Promise<{ ulid: string; url: string }> {
    const response = await visitor.context.post(
        `/api/v1/public/conversations/${ulid}/attachments`,
        {
            headers: { Authorization: `Bearer ${visitor.token}` },
            multipart: { file: { name, mimeType: 'image/png', buffer: file } },
            failOnStatusCode: false,
        },
    );
    const body = (await response.json().catch(() => ({}))) as {
        data?: { ulid: string; url: string };
    };

    if (response.status() !== 201 || !body.data) {
        throw new Error(
            `Uploading as a visitor failed: HTTP ${response.status()} ${JSON.stringify(body)}`,
        );
    }

    return body.data;
}

/** The same as an agent (the dashboard's cookie session + XSRF). */
export async function uploadAsStaff(
    actor: Pick<StaffActor, 'context'>,
    instance: Instance,
    ulid: string,
    file: Buffer,
    name = 'photo.png',
): Promise<{ ulid: string; url: string }> {
    const state = await actor.context.storageState();
    const xsrf = state.cookies.find((cookie) => cookie.name === 'XSRF-TOKEN');
    const response = await actor.context.request.post(
        `${instance.url}/api/v1/conversations/${ulid}/attachments`,
        {
            headers: {
                Accept: 'application/json',
                Origin: instance.url,
                Referer: `${instance.url}/`,
                'X-XSRF-TOKEN': decodeURIComponent(xsrf?.value ?? ''),
            },
            multipart: { file: { name, mimeType: 'image/png', buffer: file } },
            failOnStatusCode: false,
        },
    );
    const body = (await response.json().catch(() => ({}))) as {
        data?: { ulid: string; url: string };
    };

    if (response.status() !== 201 || !body.data) {
        throw new Error(
            `Uploading as staff failed: HTTP ${response.status()} ${JSON.stringify(body)}`,
        );
    }

    return body.data;
}

/** A message from the visitor with an image (and an optional caption). */
export async function sendImageAsVisitor(
    scene: Scene,
    file: Buffer,
    caption?: string,
): Promise<void> {
    const attachment = await uploadAsVisitor(scene.visitor, scene.ulid, file);

    must(
        await scene.visitor.request(
            'POST',
            `/conversations/${scene.ulid}/messages`,
            {
                client_msg_id: clientMsgId(),
                attachments: [attachment.ulid],
                ...(caption ? { body: caption } : {}),
            },
        ),
        'sending an image as a visitor',
    );
}

/** A message from the agent with an image (and an optional caption). */
export async function sendImageAsAgent(
    agent: Pick<StaffActor, 'context' | 'api'>,
    instance: Instance,
    scene: Pick<Scene, 'ulid'>,
    file: Buffer,
    caption?: string,
): Promise<void> {
    const attachment = await uploadAsStaff(agent, instance, scene.ulid, file);

    must(
        await agent.api.api.post(
            `/api/v1/conversations/${scene.ulid}/messages`,
            {
                client_msg_id: clientMsgId(),
                attachments: [attachment.ulid],
                ...(caption ? { body: caption } : {}),
            },
        ),
        'sending an image as an agent',
    );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Small page helpers shared by the view specs

/** `true` when the element's box lies within the viewport horizontally (a dialog, a popover, a card at 320/375 px). */
export async function expectInsideViewportWidth(
    locator: Locator,
    page: Page,
    message?: string,
): Promise<void> {
    const box = await locator.boundingBox();
    const width = page.viewportSize()?.width ?? 0;

    expect(box, message ?? 'the element has a box').not.toBeNull();
    expect(
        box!.x,
        `${message ?? 'element'} starts inside the viewport`,
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
        box!.x + box!.width,
        `${message ?? 'element'} ends inside the viewport`,
    ).toBeLessThanOrEqual(width + 0.5);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Accessibility scans (axe) of the dashboard and of the visitor panel

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Described = {
    id: string;
    impact: string | null | undefined;
    help: string;
    nodes: { target: string; html: string; summary: string[] }[];
};

/**
 * Runs axe in LEGACY mode on a page, or on one frame as if it were the whole page. The default mode finishes its run in a blank page it
 * opens next to the one under test, and on a mobile-emulated context that leaves the original page deaf to clicks in its lower part
 * (what was found: after the first scan, a click below about 760 px of an 839 px screen never arrives). Legacy mode needs no second page;
 * its restriction (cross-origin frames are not entered) is why the visitor panel's iframe is analysed as a document of its own.
 */
async function runAxe(
    target: Page | Frame,
    scope: { include?: string; exclude?: string } = {},
): Promise<{
    wcag: Described[];
    bestPractice: Described[];
    passes: number;
}> {
    const page = {
        evaluate: (script: unknown, arg?: unknown) =>
            (
                target.evaluate as (
                    script: unknown,
                    arg?: unknown,
                ) => Promise<unknown>
            )(script, arg),
        frames: () => ('frames' in target ? target.frames() : [target]),
    } as unknown as Page;
    let builder = new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags([...WCAG, 'best-practice']);

    if (scope.include) {
        builder = builder.include(scope.include);
    }

    if (scope.exclude) {
        builder = builder.exclude(scope.exclude);
    }

    const results = await builder.analyze();
    const describe = (
        violation: (typeof results.violations)[number],
    ): Described => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({
            target: JSON.stringify(node.target),
            html: node.html.slice(0, 200),
            summary: node.any
                .concat(node.all, node.none)
                .map((check) => check.message),
        })),
    });
    const isWcag = (violation: (typeof results.violations)[number]) =>
        violation.tags.some((tag) => WCAG.includes(tag));

    return {
        wcag: results.violations.filter(isWcag).map(describe),
        bestPractice: results.violations
            .filter((violation) => !isWcag(violation))
            .map(describe),
        passes: results.passes.length,
    };
}

async function reportAxe(
    testInfo: TestInfo,
    label: string,
    found: Awaited<ReturnType<typeof runAxe>>,
): Promise<void> {
    await testInfo.attach(`axe-${label}`, {
        body: JSON.stringify(
            { wcag: found.wcag, bestPractice: found.bestPractice },
            null,
            2,
        ),
        contentType: 'application/json',
    });

    // A scan that found nothing to check proves nothing (an empty include, a page that did not load).
    expect(found.passes, `axe ran rules on ${label}`).toBeGreaterThan(5);

    // Every WCAG A/AA violation fails, whatever axe thinks of its impact; best-practice findings are attached (and listed in the report).
    expect(found.wcag, `axe (WCAG A/AA) on ${label}`).toEqual([]);

    if (found.bestPractice.length > 0) {
        testInfo.annotations.push({
            type: 'axe best-practice',
            description: `${label}: ${found.bestPractice.map((item) => item.id).join(', ')}`,
        });
    }
}

/**
 * axe on a dashboard page in the light and the dark theme (the app follows the colour-scheme preference). Toasts are left out: they fade
 * in and out (an offer's toast stays 12 s, then leaves) and axe measures the blend with the page behind them while they do; the toast has
 * a scan of its own at rest (`scanToasts`).
 */
export async function scanDashboard(
    page: Page,
    testInfo: TestInfo,
    label: string,
): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await reportAxe(
            testInfo,
            `${label}-${theme}`,
            await runAxe(page, { exclude: '[data-sonner-toaster]' }),
        );
    }

    await setTheme(page, 'light');
}

/** axe on the toasts on screen in the CURRENT theme, once their entrance has finished (opacity 1; they stay several seconds). */
export async function scanToasts(
    page: Page,
    testInfo: TestInfo,
    label: string,
): Promise<void> {
    await expect
        .poll(() =>
            page
                .locator('[data-sonner-toast]')
                .first()
                .evaluate((toast) => getComputedStyle(toast).opacity),
        )
        .toBe('1');
    await reportAxe(
        testInfo,
        label,
        await runAxe(page, { include: '[data-sonner-toaster]' }),
    );
}

/**
 * axe on the visitor panel (the iframe inside the widget on the customer site), light and dark. Only the panel's own document is analysed (the
 * customer's own page is not ours); motion is reduced and the panel settled first so colours are measured at rest.
 */
export async function scanPanel(
    panel: Panel,
    testInfo: TestInfo,
    label: string,
    themes: ('light' | 'dark')[] = ['light', 'dark'],
): Promise<void> {
    const page = panel.page;

    for (const theme of themes) {
        await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: 'reduce',
        });
        await settleWidget(page);
        await settlePanel(panel);

        await reportAxe(
            testInfo,
            `${label}-${theme}`,
            await runAxe(await panelFrame(panel)),
        );
    }

    await page.emulateMedia({
        colorScheme: 'light',
        reducedMotion: 'no-preference',
    });
}

/** The panel's iframe as a Playwright frame. */
async function panelFrame(panel: Panel): Promise<Frame> {
    const handle = await panel.page
        .locator('pne-chat-widget .panel iframe')
        .elementHandle();
    const frame = await handle?.contentFrame();

    if (!frame) {
        throw new Error("The panel's iframe has no document to scan.");
    }

    return frame;
}

/** Waits for the panel's fonts and every finite animation or transition inside its iframe (colours measured mid-fade are wrong). */
export async function settlePanel(panel: Panel): Promise<void> {
    await panel.root.evaluate(async () => {
        await document.fonts.ready;

        const frame = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                ),
            );

        for (let pass = 0; pass < 6; pass += 1) {
            await frame();

            const running = document
                .getAnimations()
                .filter(
                    (animation) =>
                        animation.effect?.getComputedTiming().iterations !==
                        Infinity,
                );

            if (running.length === 0) {
                return;
            }

            await Promise.all(
                running.map((animation) =>
                    animation.finished.catch(() => undefined),
                ),
            );
        }
    });
}
