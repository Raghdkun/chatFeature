/**
 * Canned backend for the builder preview (`/embed/{key}?preview=1`): the panel runs the real flow (queue, an agent joining, typing,
 * replies, ending, rating, offline form) against an in-memory script and never touches the visitor API. Everything here is English
 * sample content for the admin, not visitor-facing copy.
 */
import {
    VisitorApiError,
    type MessagesPage,
    type SessionResponse,
    type VisitorApi,
} from '@/lib/chat-api/visitor';
import type {
    AttachmentData,
    ConversationPublic,
    MessageData,
} from '@/lib/chat/types';
import type {
    ConversationSocket,
    SocketFactory,
    SocketStatus,
} from '@/lib/realtime/visitor/types';

const AGENT = { name: 'Alex (preview)', avatarUrl: null };

const REPLIES = [
    'Thanks for your message! This is a preview reply, so you can see how agent messages look.',
    'Real agents answer here once the widget is live. Try an image, a long line, or a link like https://example.com.',
    'Anything else I can help with?',
];

type Listener = (payload: unknown) => void;

export function createDemoBackend(options: { delay?: number } = {}) {
    const delay = options.delay ?? 1;
    const listeners = new Map<string, Listener[]>();
    const statusHandlers: ((status: SocketStatus) => void)[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let conversation: ConversationPublic | null = null;
    let messages: MessageData[] = [];
    let seq = 0;
    let replyIndex = 0;

    const later = (ms: number, run: () => void): void => {
        timers.push(setTimeout(run, ms * delay));
    };

    const emit = (event: string, payload: unknown): void => {
        for (const handler of listeners.get(event) ?? []) {
            handler(payload);
        }
    };

    const now = (): string => new Date().toISOString();

    const push = (
        sender: MessageData['sender'],
        body: string | null,
        extra: Partial<MessageData> = {},
    ): MessageData => {
        seq += 1;

        const message: MessageData = {
            ulid: `01DEMO${String(seq).padStart(20, '0')}`,
            seq,
            conversation: conversation?.ulid ?? '01DEMO',
            sender,
            type: sender.type === 'system' ? 'system' : 'text',
            body,
            attachments: [],
            clientMsgId: null,
            createdAt: now(),
            deliveredAt: null,
            seenAt: null,
            ...extra,
        };

        messages = [...messages, message];

        return message;
    };

    const scriptAgent = (): void => {
        later(1800, () => {
            if (conversation === null) {
                return;
            }

            conversation = { ...conversation, status: 'active', agent: AGENT };
            emit('.chat.claimed', { v: 1, agent: AGENT, claimedAt: now() });
            emit('.message.created', {
                v: 1,
                message: push(
                    { type: 'system', name: null, avatarUrl: null },
                    `${AGENT.name} joined the chat.`,
                ),
            });
            later(700, () =>
                emit('.message.created', {
                    v: 1,
                    message: push(
                        { type: 'agent', ...AGENT },
                        'Hi! You are looking at a preview of your chat panel. Say something and I will answer.',
                    ),
                }),
            );
        });
    };

    const api: VisitorApi = {
        /** The builder preview shows the hand-off screen on canned data (a fictional number: nothing real is ever opened). */
        async whatsappHandoff() {
            return {
                code: 'K7M2QX4P',
                waUrl: 'https://wa.me/15550001234?text=Hi!%20My%20support%20code%20is%20K7M2QX4P',
                expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
                ttlSeconds: 24 * 3_600,
            };
        },
        async getConfig() {
            throw new VisitorApiError({
                status: 0,
                code: 'network',
                message: 'The preview has no backend.',
            });
        },
        async getAvailability() {
            throw new VisitorApiError({
                status: 0,
                code: 'network',
                message: 'The preview has no backend.',
            });
        },
        async createSession(): Promise<SessionResponse> {
            return {
                visitorToken: 'vt_preview',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                conversation: null,
                limits: null,
                ws: {
                    key: 'preview',
                    host: 'localhost',
                    port: 0,
                    scheme: 'http',
                },
            };
        },
        async revokeSession() {
            conversation = null;
            messages = [];
            seq = 0;
        },
        async getConversation() {
            return conversation;
        },
        async createConversation(request) {
            seq = 0;
            messages = [];
            conversation = {
                ulid: '01DEMO00000000000000000000',
                ticketNo: 'DEMO42',
                status: 'queued',
                type: 'live',
                category: { slug: request.category, label: request.category },
                agent: null,
                createdAt: now(),
                endedAt: null,
                ratingRequested: false,
                lastSeq: 0,
            };
            scriptAgent();

            return conversation;
        },
        async createOfflineTicket() {
            return {
                ulid: '01DEMO00000000000000000001',
                ticketNo: 'DEMO43',
                status: 'queued',
                type: 'offline',
                category: null,
                agent: null,
                createdAt: now(),
                endedAt: null,
                ratingRequested: false,
                lastSeq: 0,
            };
        },
        async listMessages(_conversation, query = {}): Promise<MessagesPage> {
            return {
                messages: messages.filter((m) => m.seq > (query.afterSeq ?? 0)),
                nextCursor: null,
            };
        },
        async sendMessage(_conversation, request) {
            const message = push(
                { type: 'visitor', name: null, avatarUrl: null },
                request.body ?? null,
                { clientMsgId: request.client_msg_id },
            );

            later(500, () =>
                emit('.client-typing', { actor: 'agent', typing: true }),
            );
            later(1700, () => {
                emit('.client-typing', { actor: 'agent', typing: false });
                emit('.message.created', {
                    v: 1,
                    message: push(
                        { type: 'agent', ...AGENT },
                        REPLIES[replyIndex++ % REPLIES.length],
                    ),
                });
            });

            return { message, replayed: false };
        },
        async sendReceipts() {
            return undefined;
        },
        async sendTyping() {
            return undefined;
        },
        async endConversation() {
            conversation = {
                ...(conversation as ConversationPublic),
                status: conversation?.status === 'queued' ? 'closed' : 'ended',
                ratingRequested: conversation?.status !== 'queued',
            };

            return conversation;
        },
        async cancelConversation() {
            conversation = {
                ...(conversation as ConversationPublic),
                status: 'closed',
            };

            return conversation;
        },
        async rateConversation() {
            return undefined;
        },
        async skipRating() {
            conversation = {
                ...(conversation as ConversationPublic),
                status: 'closed',
            };

            return conversation;
        },
        async uploadAttachment(_conversation, file): Promise<AttachmentData> {
            const url = URL.createObjectURL(file);

            return {
                ulid: `01DEMOATT${String(++seq).padStart(17, '0')}`,
                mime: file.type || 'image/png',
                size: file.size,
                width: null,
                height: null,
                url,
                thumbUrl: url,
            };
        },
    };

    const socketFactory: SocketFactory = async () => {
        const socket: ConversationSocket = {
            listen(event, handler) {
                listeners.set(event, [
                    ...(listeners.get(event) ?? []),
                    handler,
                ]);

                return () => {
                    listeners.set(
                        event,
                        (listeners.get(event) ?? []).filter(
                            (known) => known !== handler,
                        ),
                    );
                };
            },
            whisper() {
                // the demo agent does not care
            },
            onStatus(handler) {
                statusHandlers.push(handler);

                return () => undefined;
            },
            status: () => 'connected',
            onSubscribed(handler) {
                handler();

                return () => undefined;
            },
            onSubscriptionError() {
                // never refuses
                return () => undefined;
            },
            close() {
                listeners.clear();
            },
        };

        return socket;
    };

    return {
        api,
        socketFactory,
        dispose() {
            for (const timer of timers) {
                clearTimeout(timer);
            }
        },
    };
}
