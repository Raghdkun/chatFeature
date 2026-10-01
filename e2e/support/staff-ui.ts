/**
 * What the staff specs need on top of `Inbox` (`inbox.ts`) without editing it: the list column on a phone, message rows with their sender
 * and delivery state, the unseen badge, the "attention" count in the tab title and the sidebar badge, and a few typed reads of the
 * management API. Everything works with the test ids of docs/contracts/chat-ui-p4.md and `resources/js/components/inbox`.
 */
import { deflateSync } from 'node:zlib';
import { expect, type Locator, type Page } from '@playwright/test';
import type { StaffActor } from './actors';
import { must, type Conversation, type Message } from './chat-api';
import { expectEventually } from './wait';

/** The viewport width below which the inbox is a list -> detail drill-down (Tailwind `md`). */
export const PHONE_MAX_WIDTH = 767;

export const isPhone = (page: Page): boolean =>
    (page.viewportSize()?.width ?? 1280) <= PHONE_MAX_WIDTH;

/**
 * Makes the list column (queue, "My chats", presence) the visible screen. On a desktop it always is; on a phone an open conversation
 * hides it and the back arrow returns to it (an in-app navigation: the live store survives it).
 */
export async function showList(actor: StaffActor): Promise<void> {
    const back = actor.inbox.tid('conversation-back');

    if (await back.isVisible()) {
        await back.click();
    }

    await expect(actor.inbox.tid('inbox-queue')).toBeVisible();
}

/** The rows of the open conversation's message list: bubbles and system lines, not their status / retry sub-elements. */
export function rows(actor: StaffActor): Locator {
    return actor.inbox.conversation
        .getByTestId('message-list')
        .locator('li[data-testid^="message-"]');
}

/** One bubble by its text and sender (`data-sender`). */
export function bubble(
    actor: StaffActor,
    text: string | RegExp,
    from?: 'visitor' | 'agent' | 'system',
): Locator {
    return actor.inbox.conversation
        .getByTestId('message-list')
        .locator(
            from
                ? `li[data-testid^="message-"][data-sender="${from}"]`
                : 'li[data-testid^="message-"]',
        )
        .filter({ hasText: text });
}

/** The unseen badge of a "My chats" row (`0` when there is none). */
export async function unseenOf(
    actor: StaffActor,
    ulid: string,
): Promise<number> {
    const badge = actor.inbox.tid(`chat-unseen-${ulid}`);

    if ((await badge.count()) === 0) {
        return 0;
    }

    const text =
        (await badge.locator('[aria-hidden]').first().textContent()) ?? '0';

    return text.trim() === '99+' ? 99 : Number(text.trim());
}

/** The count the tab title carries (`(3) Inbox - PNE Chat` -> 3; no prefix -> 0). */
export async function titleCount(page: Page): Promise<number> {
    const match = /^\((\d+)\+?\)\s/.exec(await page.title());

    return match ? Number(match[1]) : 0;
}

/** Typed reads of the staff API that fail loudly: a conversation, its messages. */
export async function readConversation(
    actor: StaffActor,
    ulid: string,
): Promise<Conversation> {
    return must<Conversation>(
        await actor.api.conversation(ulid),
        `${actor.name} reads ${ulid}`,
    );
}

export async function readMessages(
    actor: StaffActor,
    ulid: string,
): Promise<Message[]> {
    return must<Message[]>(
        await actor.api.messages(ulid),
        `${actor.name} reads the messages of ${ulid}`,
    );
}

/** Polls the API until the conversation is in `status` (the realtime event may not have been applied by the page yet). */
export async function waitForStatus(
    actor: StaffActor,
    ulid: string,
    status: Conversation['status'],
): Promise<Conversation> {
    return expectEventually(
        () => readConversation(actor, ulid),
        (conversation) => conversation.status === status,
        { message: `conversation ${ulid} reaches ${status}` },
    );
}

/** The CRC-32 of a buffer (PNG chunks carry one); `zlib.crc32` exists from Node 22. */
function crc(buffer: Buffer): number {
    let value = 0xffffffff;

    for (const byte of buffer) {
        value ^= byte;

        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
    }

    return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    const tail = Buffer.alloc(4);

    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);

    return Buffer.concat([head, data, tail]);
}

/** A real, valid, single-colour PNG (the server judges uploads by content, so a fixture must decode). */
export function png(
    width = 24,
    height = 24,
    rgb: [number, number, number] = [37, 99, 235],
): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // truecolour
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;

    const row = Buffer.alloc(1 + width * 3);

    for (let x = 0; x < width; x += 1) {
        row[1 + x * 3] = rgb[0];
        row[2 + x * 3] = rgb[1];
        row[3 + x * 3] = rgb[2];
    }

    const raw = Buffer.concat(Array.from({ length: height }, () => row));

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
