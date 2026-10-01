import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { layoutMessages, messageKey, messageTestId } from '@/embed/lib/group';
import {
    makeAgentMessage,
    makeMessage,
    makeSystemMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { createPendingMessage, toLocalMessage } from '@/lib/chat/messages';

const at = (minutes: number, day = 20) =>
    new Date(2026, 10, day, 10, minutes).toISOString();

beforeEach(() => resetFixtures());

describe('layoutMessages', () => {
    it('starts with a date separator and groups consecutive messages of one sender', () => {
        const items = layoutMessages(
            [
                makeAgentMessage({ seq: 1, createdAt: at(0) }),
                makeAgentMessage({ seq: 2, createdAt: at(1) }),
                makeMessage({ seq: 3, createdAt: at(2) }),
                makeMessage({ seq: 4, createdAt: at(3) }),
            ].map(toLocalMessage),
        );

        expect(items.map((i) => i.kind)).toEqual([
            'separator',
            'message',
            'message',
            'message',
            'message',
        ]);

        const flags = items.flatMap((i) =>
            i.kind === 'message' ? [[i.groupStart, i.groupEnd]] : [],
        );

        expect(flags).toEqual([
            [true, false],
            [false, true],
            [true, false],
            [false, true],
        ]);
    });

    it('starts a new group after a gap of more than five minutes or a different agent', () => {
        const items = layoutMessages(
            [
                makeAgentMessage({ seq: 1, createdAt: at(0) }),
                makeAgentMessage({ seq: 2, createdAt: at(6) }),
                makeAgentMessage({
                    seq: 3,
                    createdAt: at(7),
                    sender: { type: 'agent', name: 'Kim', avatarUrl: null },
                }),
            ].map(toLocalMessage),
        );
        const starts = items.flatMap((i) =>
            i.kind === 'message' ? [i.groupStart] : [],
        );

        expect(starts).toEqual([true, true, true]);
    });

    it('puts a separator at every new day and breaks the group there', () => {
        const items = layoutMessages(
            [
                makeMessage({ seq: 1, createdAt: at(59, 19) }),
                makeMessage({ seq: 2, createdAt: at(1, 20) }),
            ].map(toLocalMessage),
        );

        expect(items.map((i) => i.kind)).toEqual([
            'separator',
            'message',
            'separator',
            'message',
        ]);
    });

    it('renders system lines on their own and breaks the run around them', () => {
        const items = layoutMessages(
            [
                makeAgentMessage({ seq: 1, createdAt: at(0) }),
                makeSystemMessage({ seq: 2, createdAt: at(1) }),
                makeAgentMessage({ seq: 3, createdAt: at(2) }),
            ].map(toLocalMessage),
        );

        expect(items.map((i) => i.kind)).toEqual([
            'separator',
            'message',
            'system',
            'message',
        ]);
        expect(items[1]).toMatchObject({ groupStart: true, groupEnd: true });
        expect(items[3]).toMatchObject({ groupStart: true, groupEnd: true });
    });

    it('keeps one key across the optimistic copy and its server copy', () => {
        const pending = createPendingMessage({
            clientMsgId: 'client-1',
            conversation: 'c',
            sender: { type: 'visitor', name: null, avatarUrl: null },
            body: 'Hi',
            createdAt: at(0),
        });
        const server = toLocalMessage(
            makeMessage({ seq: 1, clientMsgId: 'client-1', createdAt: at(0) }),
        );

        expect(messageKey(pending)).toBe(messageKey(server));
        expect(messageTestId(pending)).toBe('message-pending-client-1');
        expect(messageTestId(server)).toBe(`message-${server.ulid}`);
    });

    it('handles an empty list', () => {
        expect(layoutMessages([])).toEqual([]);
    });
});
