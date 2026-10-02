/**
 * Builders for chat data, for the UI tracks' mocks, stories and tests (never imported by production code).
 * Every builder returns a complete, valid object and takes shallow overrides; ids and times are deterministic
 * (`resetFixtures()` restarts the counters), so a snapshot or an equality check never depends on the clock.
 */
import type {
    AttachmentData,
    ConversationPublic,
    ConversationStaff,
    LocalMessage,
    MessageData,
    OfferData,
    PresenceData,
    RatingData,
} from '@/lib/chat/types';
import { toLocalMessage } from '@/lib/chat/messages';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE_TIME = Date.parse('2026-11-20T10:00:00.000Z');

let counter = 0;

/** Restart the counters (call in `beforeEach` when a test compares generated ids). */
export function resetFixtures(): void {
    counter = 0;
}

function next(): number {
    counter += 1;

    return counter;
}

/** A 26-character ULID-shaped id that is stable for the n-th call after `resetFixtures()`. Lower case, like every id the backend sends (and sorts as). */
export function fakeUlid(n: number = next()): string {
    let rest = n;
    let tail = '';

    for (let i = 0; i < 10; i++) {
        tail = CROCKFORD[rest % 32] + tail;
        rest = Math.floor(rest / 32);
    }

    return `01jfake000000000${tail.toLowerCase()}`;
}

/** ISO-8601 UTC with milliseconds, `seconds` after the fixed base time (2026-11-20T10:00:00.000Z). */
export function fakeTime(seconds: number = 0): string {
    return new Date(BASE_TIME + seconds * 1000).toISOString();
}

export function makeAttachment(
    overrides: Partial<AttachmentData> = {},
): AttachmentData {
    const ulid = overrides.ulid ?? fakeUlid();

    return {
        ulid,
        mime: 'image/webp',
        size: 48_213,
        width: 640,
        height: 480,
        url: `https://files.test/attachments/${ulid}?signature=fake`,
        thumbUrl: `https://files.test/attachments/${ulid}?thumb=1&signature=fake`,
        ...overrides,
    };
}

/** A visitor text message (seq counts up per call unless given). */
export function makeMessage(overrides: Partial<MessageData> = {}): MessageData {
    const n = next();

    return {
        ulid: fakeUlid(1000 + n),
        seq: n,
        conversation: fakeUlid(9999),
        sender: { type: 'visitor', name: 'Vera Visitor', avatarUrl: null },
        type: 'text',
        body: `Message ${n}`,
        attachments: [],
        clientMsgId: null,
        createdAt: fakeTime(n),
        deliveredAt: null,
        seenAt: null,
        ...overrides,
    };
}

/** An agent message (`sender.id` only when you ask for the staff form with `overrides.sender`). */
export function makeAgentMessage(
    overrides: Partial<MessageData> = {},
): MessageData {
    return makeMessage({
        sender: { type: 'agent', name: 'Sam', avatarUrl: null },
        ...overrides,
    });
}

export function makeSystemMessage(
    overrides: Partial<MessageData> = {},
): MessageData {
    return makeMessage({
        sender: { type: 'system', name: null, avatarUrl: null },
        type: 'system',
        body: 'Sam joined the chat.',
        ...overrides,
    });
}

/** A message in a client list: the server message plus its status (derived from the receipts unless overridden). */
export function makeLocalMessage(
    overrides: Partial<LocalMessage> = {},
): LocalMessage {
    return { ...toLocalMessage(makeMessage()), ...overrides };
}

export function makeConversationPublic(
    overrides: Partial<ConversationPublic> = {},
): ConversationPublic {
    const n = next();

    return {
        ulid: fakeUlid(2000 + n),
        ticketNo: 'K7M2QX',
        status: 'queued',
        type: 'live',
        category: { slug: 'billing', label: 'Billing' },
        agent: null,
        createdAt: fakeTime(0),
        endedAt: null,
        ratingRequested: false,
        lastSeq: 0,
        ...overrides,
    };
}

export function makeConversationStaff(
    overrides: Partial<ConversationStaff> = {},
): ConversationStaff {
    return {
        ...makeConversationPublic(),
        visitor: {
            ulid: fakeUlid(3000 + next()),
            name: 'Vera Visitor',
            email: 'vera@visitor.example',
            phone: null,
            verified: false,
            meta: {},
        },
        widget: { ulid: fakeUlid(4000), name: 'Support widget' },
        assignedAgent: null,
        unseenByAgent: 0,
        claimedAt: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        queueExpiresAt: null,
        pageUrl: null,
        pageTitle: null,
        ...overrides,
    };
}

/** An active conversation with an agent (public + staff views agree when built from the same overrides). */
export function makeActiveConversationStaff(
    overrides: Partial<ConversationStaff> = {},
): ConversationStaff {
    return makeConversationStaff({
        status: 'active',
        agent: { name: 'Sam', avatarUrl: null },
        assignedAgent: { id: 7, name: 'Sam' },
        claimedAt: fakeTime(30),
        ...overrides,
    });
}

/** The `chat.offered` payload (`v: 1`), expiring 90 s after the base time. */
export function makeOffer(overrides: Partial<OfferData> = {}): OfferData {
    return {
        v: 1,
        conversation: fakeUlid(2000 + next()),
        category: { slug: 'billing', label: 'Billing' },
        visitor: { name: 'Vera Visitor', verified: false },
        preview: 'Where is my invoice?',
        widget: { ulid: fakeUlid(4000), name: 'Support widget' },
        wave: 1,
        expiresAt: fakeTime(90),
        ttlSeconds: 90,
        ...overrides,
    };
}

export function makeRating(overrides: Partial<RatingData> = {}): RatingData {
    return {
        conversation: fakeUlid(2000),
        score: 5,
        comment: 'Quick and kind.',
        createdAt: fakeTime(600),
        ...overrides,
    };
}

export function makePresence(
    overrides: Partial<PresenceData> = {},
): PresenceData {
    return {
        userId: 7,
        status: 'online',
        isManual: false,
        lastSeenAt: fakeTime(0),
        ...overrides,
    };
}
