/**
 * The visitor's side in the browser: the real widget on the customer-site page and, inside its iframe, the chat panel. Everything works
 * at the DOM level with the test ids of docs/contracts/chat-ui-p4.md (`chat-panel`, `chat-state[data-state]`, `prechat-form`,
 * `category-option-{slug}`, `queued-timer`, `message-list`, `composer-input`, `composer-send`, `end-chat`, `rating-stars`, ...).
 *
 *   const panel = await openCustomerSite(page, instance, { open: true });
 *   const chat = await panel.startChat({ category: 'billing', name: 'Vera Visitor' });   // -> queued
 *   await panel.expectState('active');                                                      // after an agent accepted
 */
import {
    expect,
    type FrameLocator,
    type Locator,
    type Page,
} from '@playwright/test';
import { hostPage, settleWidget, type HostOptions } from './host';
import type { Instance } from './scenarios';
import { readSeed } from './chat-seed';

/** The `data-state` values of the panel (docs/contracts/chat-ui-p4.md). */
export type PanelState =
    | 'booting'
    | 'idle'
    | 'prechat'
    | 'category'
    | 'queued'
    | 'active'
    | 'ended'
    | 'offline'
    | 'closed';

export type StartChatOptions = {
    /** Category slug (`billing`, `sales`, `general`): clicked on the topic screen. */
    category: string;
    name?: string;
    email?: string;
    phone?: string;
    /** Tick the consent box when the widget asks for one. */
    consent?: boolean;
};

export type StartedChat = {
    /** The conversation the panel created (`null` when the widget answered `no_agents` and showed the offline form). */
    ulid: string | null;
    ticketNo: string | null;
    /** HTTP status of `POST /public/conversations`. */
    status: number;
};

export class Panel {
    /** The launcher button in the widget's open shadow root, on the customer-site page. */
    readonly launcher: Locator;
    /** The panel iframe's contents (`/embed/<key>`). */
    readonly frame: FrameLocator;

    constructor(
        readonly page: Page,
        readonly instance: Instance,
    ) {
        this.launcher = page.locator('pne-chat-widget button.launcher');
        this.frame = page.frameLocator('pne-chat-widget .panel iframe');
    }

    /** A test id inside the panel. */
    tid(id: string | RegExp): Locator {
        return this.frame.getByTestId(id);
    }

    get root(): Locator {
        return this.tid('chat-panel');
    }
    get stateElement(): Locator {
        return this.tid('chat-state');
    }
    get messageList(): Locator {
        return this.tid('message-list');
    }
    get composerInput(): Locator {
        return this.tid('composer-input');
    }

    /** Opens the panel (launcher click) and waits until it is up. A panel that is already open is left alone. */
    async open(): Promise<void> {
        await expect(this.launcher).toBeVisible();
        await settleWidget(this.page);

        if (!(await this.root.isVisible())) {
            await this.launcher.click();
        }

        await expect(this.root).toBeVisible();
        await expect(this.stateElement).not.toHaveAttribute(
            'data-state',
            'booting',
        );
    }

    /** The current `data-state`. */
    async state(): Promise<PanelState> {
        return (await this.stateElement.getAttribute(
            'data-state',
        )) as PanelState;
    }

    async expectState(
        state: PanelState | PanelState[],
        timeout = 15_000,
    ): Promise<void> {
        await expect(this.stateElement).toHaveAttribute(
            'data-state',
            Array.isArray(state) ? new RegExp(`^(${state.join('|')})$`) : state,
            { timeout },
        );
    }

    /**
     * Walks the topic flow the widget asks for (welcome -> pre-chat form -> topic -> waiting) and returns once the panel is `queued`
     * (or `offline` when nobody can answer). Fields the widget does not ask for are ignored. The conversation's ulid is read from the
     * answer of `POST /public/conversations`.
     */
    async startChat(options: StartChatOptions): Promise<StartedChat> {
        const created = this.page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    '/api/v1/public/conversations' &&
                response.request().method() === 'POST',
        );
        let last: PanelState | null = null;

        for (let step = 0; step < 8; step += 1) {
            if (last !== null) {
                await expect(this.stateElement).not.toHaveAttribute(
                    'data-state',
                    last,
                );
            }

            await this.expectState([
                'idle',
                'prechat',
                'category',
                'queued',
                'offline',
                'active',
            ]);

            const state = await this.state();

            if (
                state === 'queued' ||
                state === 'offline' ||
                state === 'active'
            ) {
                break;
            }

            if (state === 'idle') {
                await this.tid('idle-start').click();
            } else if (state === 'prechat') {
                await this.fillPrechat(options);
            } else if (state === 'category') {
                await this.tid(`category-option-${options.category}`).click();
            }

            last = state;
        }

        await this.expectState(['queued', 'offline', 'active']);

        const response = await created.catch(() => null);
        const data = response
            ? ((await response.json().catch(() => ({}))) as { data?: any }).data
            : undefined;

        return {
            ulid: data?.ulid ?? null,
            ticketNo: data?.ticketNo ?? null,
            status: response?.status() ?? 0,
        };
    }

    private async fillPrechat(options: StartChatOptions): Promise<void> {
        const form = this.tid('prechat-form');

        for (const field of ['name', 'email', 'phone'] as const) {
            const value = options[field];
            const input = form.locator(`input[name="${field}"]`);

            if (value !== undefined && (await input.count()) > 0) {
                await input.fill(value);
            }
        }

        const consent = form.locator('input[name="consent"]');

        if ((await consent.count()) > 0 && options.consent !== false) {
            await consent.check();
        }

        await form.locator('button[type="submit"]').click();
    }

    /** Types into the composer and sends (the send button, as a visitor would). */
    async send(text: string): Promise<void> {
        await this.composerInput.fill(text);
        await this.tid('composer-send').click();
    }

    /** A message in the list with this text; `from` narrows it to who sent it (`data-sender`). */
    message(
        text: string | RegExp,
        from?: 'visitor' | 'agent' | 'system',
    ): Locator {
        const bubble = this.messageList.locator(
            from
                ? `[data-testid^="message-"][data-sender="${from}"]`
                : '[data-testid^="message-"]',
        );

        return bubble.filter({ hasText: text });
    }

    async expectMessage(
        text: string | RegExp,
        from?: 'visitor' | 'agent' | 'system',
    ): Promise<void> {
        await expect(this.message(text, from).first()).toBeVisible();
    }

    /** "End chat" in the header and its confirmation dialog. */
    async endChat(): Promise<void> {
        await this.tid('end-chat').click();
        await this.tid('end-chat-confirm').click();
    }

    /** The rating card of an ended chat: pick the stars (1-5), optional comment, send. */
    async rate(stars: 1 | 2 | 3 | 4 | 5, comment?: string): Promise<void> {
        await this.expectState('ended');
        await this.tid(`rating-star-${stars}`).click();

        if (comment !== undefined) {
            await this.tid('rating-comment').fill(comment);
        }

        await this.tid('rating-submit').click();
    }

    async skipRating(): Promise<void> {
        await this.expectState('ended');
        await this.tid('rating-skip').click();
    }

    /** "Cancel" while queued. */
    async cancelQueued(): Promise<void> {
        await this.tid('queued-cancel').click();
    }

    /** "Start a new chat" on the closing screen. */
    async newChat(): Promise<void> {
        await this.tid('new-chat').click();
    }

    /**
     * The visitor's bearer token the loader keeps in the HOST page's localStorage (`chatfeature:<key>:session`): lets a spec call the
     * public API as the very visitor the browser plays. `null` before the panel created a session.
     */
    async visitorToken(
        key = readSeed(this.instance).widget.key,
    ): Promise<string | null> {
        return this.page.evaluate((storageKey) => {
            try {
                const raw = window.localStorage.getItem(storageKey);

                return raw === null ? null : (JSON.parse(raw).token as string);
            } catch {
                return null;
            }
        }, `chatfeature:${key}:session`);
    }
}

export type SiteOptions = Partial<HostOptions> & {
    /** Prefill, as the host page's `ChatFeatureSettings.visitor`. */
    visitor?: {
        name?: string;
        email?: string;
        phone?: string;
        meta?: Record<string, unknown>;
    };
    /** A signed identity (HS256 JWT) from `mintIdentityToken()`. */
    identityToken?: string;
    /** Open the panel too (default false: only the launcher is up). */
    open?: boolean;
};

/**
 * Loads the customer-site page with the real loader (`/w/<key>.js`, on another origin than the app) and waits for the launcher. The
 * widget is the seeded "Acme Storefront" unless `key` says otherwise. `visitor` / `identityToken` go to `ChatFeatureSettings`; any other
 * `HostOptions` (hostile CSS, `rtl`, `csp`, `attrs`, ...) work as in the P3 specs. Returns the visitor's `Panel`.
 */
export async function openCustomerSite(
    page: Page,
    instance: Instance,
    options: SiteOptions = {},
): Promise<Panel> {
    const { visitor, identityToken, open, key, settings, ...rest } = options;
    const url = hostPage(instance, {
        ...rest,
        key: key ?? readSeed(instance).widget.key,
        settings: {
            ...settings,
            ...(visitor ? { visitor } : {}),
            ...(identityToken ? { identityToken } : {}),
        },
    });

    await page.goto(url);

    const panel = new Panel(page, instance);

    await expect(panel.launcher).toBeVisible();

    if (open) {
        await panel.open();
    }

    return panel;
}
