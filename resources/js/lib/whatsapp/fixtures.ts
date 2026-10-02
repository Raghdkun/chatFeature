/**
 * Builders for WhatsApp data, for tests and mocks (never imported by production code). Like `@/lib/chat/fixtures`: every builder returns
 * a complete, valid object and takes shallow overrides; ids and times are deterministic (`resetFixtures()` of the chat fixtures
 * restarts the counters).
 */
import { fakeTime, fakeUlid } from '@/lib/chat/fixtures';
import type {
    HandoffResponse,
    WaChat,
    WaChatDetail,
    WaMessage,
    WhatsAppSession,
} from '@/lib/whatsapp/types';

let counter = 0;

/** Restart the counters of these builders (the chat fixtures have their own `resetFixtures()`). */
export function resetWaFixtures(): void {
    counter = 0;
}

function next(): number {
    counter += 1;

    return counter;
}

export function makeWaSession(
    overrides: Partial<WhatsAppSession> = {},
): WhatsAppSession {
    const n = next();

    return {
        ulid: fakeUlid(5000 + n),
        name: `support-${n}`,
        engine: 'whatsapp-web.js',
        status: 'ready',
        phone: '+491701234567',
        maskedPhone: '+49•••••••4567',
        pushName: 'PNE Support',
        qrAvailable: false,
        lastQrAt: null,
        webhookRegistered: true,
        webhookUrl: 'https://chat.example.com/webhooks/openwa/01JFAKE',
        readyAt: fakeTime(-3600),
        lastError: null,
        linkedWidgetsCount: 0,
        isLinkedToWidgets: false,
        sendMinIntervalMs: 1500,
        dailySendCap: 200,
        pacingOverridden: false,
        createdAt: fakeTime(-7200),
        ...overrides,
    };
}

export function makeWaChat(overrides: Partial<WaChat> = {}): WaChat {
    const n = next();
    const session = overrides.session ?? {
        ulid: fakeUlid(5000),
        name: 'support-1',
    };

    return {
        ulid: fakeUlid(6000 + n),
        session,
        phone: '+4915112345678',
        pushName: 'Vera Visitor',
        isGroup: false,
        status: 'open',
        linked: false,
        widget: null,
        category: null,
        unreadByAdmin: 0,
        inboundInitiated: true,
        lastInboundAt: fakeTime(n * 10),
        lastMessageAt: fakeTime(n * 10),
        lastMessagePreview: `Hello ${n}`,
        createdAt: fakeTime(n),
        ...overrides,
    };
}

export function makeLinkedWaChat(overrides: Partial<WaChat> = {}): WaChat {
    return makeWaChat({
        linked: true,
        widget: { ulid: fakeUlid(100), name: 'Main site' },
        category: { slug: 'sales', label: 'Sales' },
        ...overrides,
    });
}

/** An inbound text message (the chat ulid is `chat`). */
export function makeWaMessage(overrides: Partial<WaMessage> = {}): WaMessage {
    const n = next();

    return {
        ulid: fakeUlid(7000 + n),
        chat: fakeUlid(6001),
        direction: 'in',
        type: 'text',
        body: `Message ${n}`,
        media: null,
        status: 'received',
        error: null,
        sentBy: null,
        waTimestamp: fakeTime(n * 5),
        createdAt: fakeTime(n * 5),
        ...overrides,
    };
}

/** An outbound reply sent by an administrator (status `sent` unless overridden). */
export function makeWaReply(overrides: Partial<WaMessage> = {}): WaMessage {
    return makeWaMessage({
        direction: 'out',
        status: 'sent',
        sentBy: { id: 1, name: 'Ada' },
        body: 'Thanks, one moment.',
        ...overrides,
    });
}

export function makeWaImage(overrides: Partial<WaMessage> = {}): WaMessage {
    const message = makeWaMessage({ type: 'image', body: 'Look at this' });

    return {
        ...message,
        media: {
            mime: 'image/jpeg',
            filename: 'photo.jpg',
            size: 48_000,
            available: true,
            url: `https://files.test/whatsapp/${message.ulid}?signature=fake`,
        },
        ...overrides,
    };
}

export function makeWaDocument(overrides: Partial<WaMessage> = {}): WaMessage {
    return makeWaMessage({
        type: 'document',
        body: null,
        media: {
            mime: 'application/pdf',
            filename: 'invoice.pdf',
            size: 120_000,
            available: false,
            url: null,
        },
        ...overrides,
    });
}

export function makeWaChatDetail(
    overrides: Partial<WaChatDetail> = {},
): WaChatDetail {
    return {
        chat: makeWaChat(),
        visitor: null,
        handoff: null,
        ...overrides,
    };
}

export function makeHandoff(
    overrides: Partial<HandoffResponse> = {},
): HandoffResponse {
    return {
        code: 'K7M2QX4P',
        waUrl: 'https://wa.me/491701234567?text=Hi%21%20My%20support%20code%20is%20K7M2QX4P',
        expiresAt: fakeTime(24 * 3600),
        ttlSeconds: 24 * 3600,
        ...overrides,
    };
}
