/**
 * The agent's side in the browser: the inbox (`/inbox`, `/inbox/{ulid}`) at the DOM level with the test ids of
 * docs/contracts/chat-ui-p4.md and the components under `resources/js/components/inbox`: `inbox`, `inbox-queue`, `offer-{ulid}`
 * (`data-state`: `open` | `taken` | `expired`), `offer-accept-{ulid}`, `inbox-mine`, `chat-row-{ulid}`, `chat-unseen-{ulid}`,
 * `conversation-view`, `message-list`, `message-{ulid}`, `composer-input`, `composer-send`, `end-chat`, `transfer-chat`, `presence-select`.
 *
 * On a phone the inbox is a list -> detail drill-down: the list screen (queue, my chats) and the conversation are never on screen
 * together; the helpers below say which one they need.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class Inbox {
    constructor(readonly page: Page) {}

    tid(id: string | RegExp): Locator {
        return this.page.getByTestId(id);
    }

    /** Opens `/inbox` (or one conversation) and waits for the shell. */
    async goto(ulid?: string): Promise<void> {
        await this.page.goto(ulid ? `/inbox/${ulid}` : '/inbox');
        await expect(this.tid('inbox')).toBeVisible();
    }

    get queue(): Locator {
        return this.tid('inbox-queue');
    }
    get mine(): Locator {
        return this.tid('inbox-mine');
    }
    get conversation(): Locator {
        return this.tid('conversation-view');
    }
    get composerInput(): Locator {
        return this.tid('composer-input');
    }

    /** The offer card of a conversation in the queue. */
    offer(ulid: string): Locator {
        return this.tid(`offer-${ulid}`);
    }

    /** Every offer card (any conversation): `toHaveCount(0)` is "nothing was offered to me". */
    get offers(): Locator {
        return this.queue.getByTestId(/^offer-[0-9a-z]{26}$/);
    }

    async expectOffer(ulid: string): Promise<void> {
        await expect(this.offer(ulid)).toBeVisible();
    }

    async expectNoOffer(ulid: string): Promise<void> {
        await expect(this.offer(ulid)).toHaveCount(0);
    }

    /** "Accept" on the offer; resolves when the conversation is open (the page navigated to `/inbox/{ulid}`). */
    async accept(ulid: string): Promise<void> {
        await this.tid(`offer-accept-${ulid}`).click();
        await expect(this.page).toHaveURL(new RegExp(`/inbox/${ulid}$`));
        await expect(this.conversation).toBeVisible();
    }

    /** A row of "My chats". */
    chatRow(ulid: string): Locator {
        return this.tid(`chat-row-${ulid}`);
    }

    /** A message in the open conversation with this text. */
    message(text: string | RegExp): Locator {
        return this.conversation
            .getByTestId('message-list')
            .locator('[data-testid^="message-"]')
            .filter({ hasText: text });
    }

    async expectMessage(text: string | RegExp): Promise<void> {
        await expect(this.message(text).first()).toBeVisible();
    }

    async send(text: string): Promise<void> {
        await this.composerInput.fill(text);
        await this.tid('composer-send').click();
    }

    /** "End chat" in the conversation header and its confirmation. */
    async endChat(): Promise<void> {
        await this.tid('end-chat').click();
        await this.tid('end-chat-confirm').click();
    }
}
