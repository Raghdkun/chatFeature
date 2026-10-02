import { describe, expect, it } from 'vite-plus/test';
import {
    CHAT_EVENT,
    PAYLOAD_VERSION,
    WA_EVENT,
    channels,
    echoEvent,
    waChannels,
    waEchoEvent,
    type ChatEventName,
    type ChatEventPayloads,
    type WaEventName,
    type WaEventPayloads,
} from '@/lib/chat/events';

describe('chat events', () => {
    it('names every event of the realtime contract once', () => {
        expect(Object.values(CHAT_EVENT).sort()).toEqual(
            [
                'chat.assigned',
                'chat.claimed',
                'chat.offered',
                'chat.taken',
                'client-typing',
                'conversation.closed',
                'conversation.ended',
                'conversation.missed',
                'conversation.rated',
                'conversation.transferred',
                'conversation.updated',
                'message.created',
                'message.delivered',
                'message.seen',
                'offline-ticket.created',
                'presence.changed',
                'queue.updated',
                'session.revoked',
                'typing',
                'unread.updated',
            ].sort(),
        );
    });

    it('has a payload type for every event name (compile-time)', () => {
        const names: Record<ChatEventName, keyof ChatEventPayloads> = {
            'chat.offered': 'chat.offered',
            'chat.taken': 'chat.taken',
            'chat.assigned': 'chat.assigned',
            'chat.claimed': 'chat.claimed',
            'conversation.updated': 'conversation.updated',
            'unread.updated': 'unread.updated',
            'queue.updated': 'queue.updated',
            'session.revoked': 'session.revoked',
            'presence.changed': 'presence.changed',
            'message.created': 'message.created',
            'message.delivered': 'message.delivered',
            'message.seen': 'message.seen',
            'conversation.ended': 'conversation.ended',
            'conversation.closed': 'conversation.closed',
            'conversation.missed': 'conversation.missed',
            'conversation.transferred': 'conversation.transferred',
            'offline-ticket.created': 'offline-ticket.created',
            'conversation.rated': 'conversation.rated',
            'client-typing': 'client-typing',
            typing: 'typing',
        };

        expect(Object.keys(names)).toHaveLength(Object.keys(CHAT_EVENT).length);
    });

    it('listens with a leading dot (custom broadcastAs names)', () => {
        expect(echoEvent(CHAT_EVENT.messageCreated)).toBe('.message.created');
        expect(echoEvent(CHAT_EVENT.messageDelivered)).toBe(
            '.message.delivered',
        );
        expect(echoEvent(CHAT_EVENT.typing)).toBe('.client-typing');
        expect(echoEvent(CHAT_EVENT.typingFallback)).toBe('.typing');
    });

    it('builds channel names without the private-/presence- prefix', () => {
        expect(channels.staff(42)).toBe('staff.42');
        expect(channels.conversation('01JABC')).toBe('conversation.01JABC');
        expect(channels.admin).toBe('admin');
        expect(channels.presenceStaff).toBe('staff');
        expect(PAYLOAD_VERSION).toBe(1);
    });
});

describe('whatsapp admin events', () => {
    it('names the four events of the admin-only channel once', () => {
        expect(Object.values(WA_EVENT).sort()).toEqual(
            [
                'wa.chat.updated',
                'wa.message.created',
                'wa.message.updated',
                'wa.session.status',
            ].sort(),
        );
    });

    it('has a payload type for every event name (compile-time)', () => {
        const names: Record<WaEventName, keyof WaEventPayloads> = {
            'wa.message.created': 'wa.message.created',
            'wa.message.updated': 'wa.message.updated',
            'wa.chat.updated': 'wa.chat.updated',
            'wa.session.status': 'wa.session.status',
        };

        expect(Object.keys(names)).toHaveLength(Object.keys(WA_EVENT).length);
    });

    it('keeps the WhatsApp names apart from the chat names', () => {
        const chatNames: string[] = Object.values(CHAT_EVENT);

        for (const name of Object.values(WA_EVENT)) {
            expect(chatNames).not.toContain(name);
            expect(name.startsWith('wa.')).toBe(true);
        }
    });

    it('listens with a leading dot (custom broadcastAs names)', () => {
        expect(waEchoEvent(WA_EVENT.messageCreated)).toBe(
            '.wa.message.created',
        );
        expect(waEchoEvent(WA_EVENT.sessionStatus)).toBe('.wa.session.status');
    });

    it('builds the channel name without the private- prefix, separate from the admin channel', () => {
        expect(waChannels.admin).toBe('whatsapp-admin');
        expect(waChannels.admin).not.toBe(channels.admin);
    });
});
