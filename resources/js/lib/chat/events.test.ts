import { describe, expect, it } from 'vite-plus/test';
import {
    CHAT_EVENT,
    PAYLOAD_VERSION,
    channels,
    echoEvent,
    type ChatEventName,
    type ChatEventPayloads,
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
