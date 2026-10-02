/**
 * The launcher on the customer site as the P5 alert specs see it (docs/widget-embed-api.md, "Unread badge and reply alert"): the badge, the
 * accessible label with the count, the alert state (`data-alert` on the button) and the announcement region, plus a recorder
 * (`installAlertTracker`) that counts how many times the alert really ran (the attribute is set to `true` once per alert). All of it is in the loader's open
 * shadow root, which Playwright pierces.
 */
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { chatFeature, recordedEvents } from './host';

export class Launcher {
    readonly button: Locator;
    readonly badge: Locator;
    readonly card: Locator;
    readonly ring: Locator;
    readonly root: Locator;
    /** The visually hidden polite `role="status"` region that announces the label with the count. */
    readonly announcement: Locator;

    constructor(readonly page: Page) {
        this.button = page.locator('pne-chat-widget button.launcher');
        this.badge = page.locator('pne-chat-widget .badge');
        this.card = page.locator('pne-chat-widget .launcher .card');
        this.ring = page.locator('pne-chat-widget .launcher .ring');
        this.root = page.locator('pne-chat-widget .root');
        this.announcement = page.locator('pne-chat-widget .sr[role="status"]');
    }

    /** The number the badge shows (0 when it is hidden). */
    async count(): Promise<number> {
        const shown = await this.badge.getAttribute('data-show');

        return shown === 'true'
            ? Number((await this.badge.textContent())?.replace('+', '') ?? 0)
            : 0;
    }

    /** `ChatFeature('getState').unread`, the number host code sees. */
    async stateUnread(): Promise<number> {
        const state = await chatFeature<{ unread: number }>(
            this.page,
            'getState',
        );

        return state.unread;
    }

    /** `unread-changed` events the host page recorded, as the counts they carried, oldest first. */
    async unreadEvents(): Promise<number[]> {
        return (await recordedEvents(this.page))
            .filter((event) => event.name === 'unread-changed')
            .map((event) => Number(event.data.count));
    }

    async alerts(): Promise<number> {
        return this.page.evaluate(
            () => (window as unknown as { __alerts?: number }).__alerts ?? 0,
        );
    }

    /** The bubble: `ChatFeature('open')` / `('close')`, the host page's own API (works on a phone, where the launcher steps aside). */
    open(): Promise<unknown> {
        return chatFeature(this.page, 'open');
    }

    close(): Promise<unknown> {
        return chatFeature(this.page, 'close');
    }
}

/**
 * Counts the alerts of every page of a context from the very first moment (an init script, install it before the pages load): a page that
 * navigates, or a second tab, is counted too, and an alert that fires the instant the launcher appears is not missed. `Launcher.alerts()` is
 * the count of the document it is asked in.
 */
export async function installAlertTracker(
    context: BrowserContext,
): Promise<void> {
    await context.addInitScript(() => {
        const w = window as unknown as { __alerts?: number };
        let watched: Element | null = null;

        w.__alerts = 0;

        const attach = (): void => {
            const button = document
                .querySelector('pne-chat-widget')
                ?.shadowRoot?.querySelector('button.launcher');

            if (!button || button === watched) {
                return;
            }

            watched = button;
            // `alert()` sets the attribute to `false` and, in the same task, to `true` again: the records of one batch are the whole story, and
            // the value a record SET is the next record's `oldValue` (the element's current value for the last one).
            new MutationObserver((records) => {
                records.forEach((record, index) => {
                    const next =
                        index + 1 < records.length
                            ? records[index + 1].oldValue
                            : (record.target as HTMLElement).dataset.alert;

                    if (
                        record.attributeName === 'data-alert' &&
                        next === 'true'
                    ) {
                        w.__alerts = (w.__alerts ?? 0) + 1;
                    }
                });
            }).observe(button, {
                attributes: true,
                attributeFilter: ['data-alert'],
                attributeOldValue: true,
            });
        };

        new MutationObserver(attach).observe(document, {
            childList: true,
            subtree: true,
        });
        attach();
    });
}
