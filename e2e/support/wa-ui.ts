/**
 * DOM helpers for the WhatsApp pages of the dashboard (`/settings/whatsapp`, `/whatsapp`, `/whatsapp/chats/{ulid}`), by the test ids of
 * `resources/js/components/whatsapp/**` (the contract with the 6B frontend).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { WaSessionStatus } from './whatsapp';

/** Settings > WhatsApp: the connection card, the sessions card, the behaviour card. */
export class WaSettingsPage {
    constructor(readonly page: Page) {}

    async goto(): Promise<void> {
        await this.page.goto('/settings/whatsapp');
        await expect(this.page.getByTestId('settings-whatsapp')).toBeVisible();
        await expect(this.page.getByTestId('wa-sessions-card')).toBeVisible();
    }

    row = (ulid: string): Locator =>
        this.page.getByTestId(`wa-session-${ulid}`);
    button = (action: string, ulid: string): Locator =>
        this.page.getByTestId(`wa-session-${action}-${ulid}`);
    badge = (ulid: string): Locator =>
        this.page.getByTestId(`wa-session-status-${ulid}`);

    /** The status badge says so (the `data-status` attribute carries the machine name, the text the translation). */
    async expectStatus(ulid: string, status: WaSessionStatus): Promise<void> {
        await expect(this.badge(ulid)).toHaveAttribute('data-status', status);
    }

    get connectionCard(): Locator {
        return this.page.getByTestId('wa-connection-card');
    }
    get sessionName(): Locator {
        return this.page.getByTestId('wa-session-name');
    }
    get create(): Locator {
        return this.page.getByTestId('wa-session-create');
    }
    get qrDialog(): Locator {
        return this.page.getByTestId('wa-qr-dialog');
    }

    /** Types a name and presses "Add session". */
    async createSession(name: string): Promise<void> {
        await this.sessionName.fill(name);
        await this.create.click();
    }
}

/** The WhatsApp inbox: list column, filters, the open chat with its transcript and composer. */
export class WaInboxPage {
    private subscribed = false;

    constructor(readonly page: Page) {
        // The page's own Reverb socket tells when the admin channel is joined (the frame Pusher sends): events published before that moment are not
        // heard, and the page catches up at connection time, not at subscription time (see docs/testing.md, "P6 specs"). Specs that inject a
        // message right after loading wait for it through `goto()`.
        page.on('websocket', (socket) =>
            socket.on('framereceived', (frame) => {
                const payload = String(frame.payload);

                if (
                    payload.includes('subscription_succeeded') &&
                    payload.includes('private-whatsapp-admin')
                ) {
                    this.subscribed = true;
                }
            }),
        );
    }

    /**
     * `/whatsapp`, or one chat (`/whatsapp/chats/{ulid}`). Returns once the admin channel is joined, so what a spec injects next arrives live
     * (`live: false` for a browser whose socket is cut on purpose).
     */
    async goto(chat?: string, options: { live?: boolean } = {}): Promise<void> {
        this.subscribed = false;
        await this.page.goto(chat ? `/whatsapp/chats/${chat}` : '/whatsapp');
        await expect(this.page.getByTestId('wa-inbox')).toBeVisible();

        if (chat) {
            await expect(this.page.getByTestId('wa-chat-view')).toBeVisible();
        }

        if (options.live !== false) {
            await expect
                .poll(() => this.subscribed, {
                    message: 'the page to join private-whatsapp-admin',
                    timeout: 20_000,
                })
                .toBe(true);
        }
    }

    row = (ulid: string): Locator =>
        this.page.getByTestId(`wa-chat-row-${ulid}`);
    unread = (ulid: string): Locator =>
        this.page.getByTestId(`wa-chat-unread-${ulid}`);
    message = (ulid: string): Locator =>
        this.page.getByTestId(`wa-message-${ulid}`);
    /** A transcript bubble by its text. */
    bubble = (text: string | RegExp): Locator =>
        this.page
            .getByTestId('wa-transcript')
            .locator('li[data-testid^="wa-message-"]')
            .filter({ hasText: text });

    get composer(): Locator {
        return this.page.getByTestId('wa-composer-input');
    }
    get send(): Locator {
        return this.page.getByTestId('wa-composer-send');
    }
    get search(): Locator {
        return this.page.getByTestId('wa-search');
    }
    get navBadge(): Locator {
        return this.page.getByTestId('nav-badge-whatsapp');
    }

    /** Types a reply and sends it with Enter. */
    async reply(text: string): Promise<void> {
        await this.composer.fill(text);
        await this.page.keyboard.press('Enter');
    }

    /** The visible chat rows, newest activity first (their ulids). */
    async rowUlids(): Promise<string[]> {
        const ids = await this.page
            .locator('[data-testid^="wa-chat-row-"]')
            .evaluateAll((nodes) =>
                nodes.map((node) =>
                    (node.getAttribute('data-testid') ?? '').replace(
                        'wa-chat-row-',
                        '',
                    ),
                ),
            );

        return ids;
    }
}
