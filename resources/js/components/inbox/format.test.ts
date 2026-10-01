import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
    buildListEntries,
    buildTranscript,
    clockLabel,
    dayLabel,
    GROUP_GAP_MS,
    linkify,
    secondsSince,
    secondsUntil,
    shortAge,
} from '@/components/inbox/format';
import {
    exportUrl,
    hasActiveFilters,
    historyQuery,
    NO_FILTERS,
    pageWindow,
} from '@/components/inbox/history-model';
import {
    fakeTime,
    makeAgentMessage,
    makeAttachment,
    makeLocalMessage,
    makeMessage,
    makeSystemMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { toLocalMessage } from '@/lib/chat/messages';
import type { LocalMessage, MessageData } from '@/lib/chat/types';
import { interpolate } from '@/lib/i18n';
import { en } from '@/tests/lang';

const t = (key: string, replacements?: Record<string, string | number>) =>
    interpolate(en[key] ?? key, replacements);

beforeEach(() => resetFixtures());

const at = (iso: string) => Date.parse(iso);

describe('shortAge', () => {
    const now = at('2026-11-20T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();

    it('says "now" under a minute, then narrow units', () => {
        expect(shortAge(ago(20_000), now, 'en', t)).toBe('now');
        expect(shortAge(ago(5 * 60_000), now, 'en', t)).toBe('5m');
        expect(shortAge(ago(3 * 3_600_000), now, 'en', t)).toBe('3h');
        expect(shortAge(ago(2 * 86_400_000), now, 'en', t)).toBe('2d');
    });

    it('falls back to a short date after a week, and to null for nothing', () => {
        expect(shortAge(ago(10 * 86_400_000), now, 'en', t)).toMatch(/Nov/);
        expect(shortAge(null, now, 'en', t)).toBeNull();
        expect(shortAge('garbage', now, 'en', t)).toBeNull();
    });

    it('never goes negative for a clock that is slightly behind', () => {
        expect(shortAge(new Date(now + 5000).toISOString(), now, 'en', t)).toBe(
            'now',
        );
    });

    it('formats numbers in the locale', () => {
        expect(shortAge(ago(5 * 60_000), now, 'ar', t)).not.toBe('5m');
    });
});

describe('dayLabel', () => {
    const now = new Date(2026, 10, 20, 15, 0, 0).getTime();

    it('says Today and Yesterday, then the date', () => {
        expect(
            dayLabel(new Date(2026, 10, 20, 1, 0).toISOString(), now, 'en', t),
        ).toBe('Today');
        expect(
            dayLabel(new Date(2026, 10, 19, 23, 0).toISOString(), now, 'en', t),
        ).toBe('Yesterday');
        expect(
            dayLabel(new Date(2026, 10, 10, 9, 0).toISOString(), now, 'en', t),
        ).toMatch(/10/);
        expect(dayLabel('nope', now, 'en', t)).toBe('');
    });
});

describe('countdowns', () => {
    it('formats m:ss and clamps', () => {
        expect(clockLabel(0)).toBe('0:00');
        expect(clockLabel(9)).toBe('0:09');
        expect(clockLabel(75)).toBe('1:15');
        expect(clockLabel(-5)).toBe('0:00');
    });

    it('measures seconds until a deadline and since a start', () => {
        const now = at('2026-11-20T10:00:00.000Z');

        expect(secondsUntil('2026-11-20T10:00:30.000Z', now)).toBe(30);
        expect(secondsUntil('2026-11-20T10:00:00.400Z', now)).toBe(1);
        expect(secondsUntil('2026-11-20T09:59:00.000Z', now)).toBe(0);
        expect(secondsUntil(null, now)).toBeNull();
        expect(secondsSince('2026-11-20T09:59:15.000Z', now)).toBe(45);
        expect(secondsSince('2026-11-20T10:05:00.000Z', now)).toBe(0);
    });
});

describe('buildListEntries', () => {
    const local = (overrides: Partial<MessageData>) =>
        toLocalMessage(makeMessage(overrides));
    const kinds = (messages: LocalMessage[]) =>
        buildListEntries(messages).map((entry) =>
            entry.kind === 'day'
                ? 'day'
                : `${entry.message.sender.type}${entry.startsGroup ? '[' : ''}${entry.endsGroup ? ']' : ''}`,
        );

    it('puts a day divider before the first message and whenever the day changes', () => {
        const messages = [
            local({ seq: 1, createdAt: '2026-11-20T10:00:00.000Z' }),
            local({ seq: 2, createdAt: '2026-11-20T10:00:30.000Z' }),
            local({ seq: 3, createdAt: '2026-11-22T10:00:00.000Z' }),
        ];

        expect(kinds(messages)).toEqual([
            'day',
            'visitor[',
            'visitor]',
            'day',
            'visitor[]',
        ]);
    });

    it('groups consecutive messages of one sender and splits on another sender or a long pause', () => {
        const base = at('2026-11-20T10:00:00.000Z');
        const iso = (ms: number) => new Date(base + ms).toISOString();
        const messages = [
            local({ seq: 1, createdAt: iso(0) }),
            local({ seq: 2, createdAt: iso(10_000) }),
            toLocalMessage(
                makeAgentMessage({ seq: 3, createdAt: iso(20_000) }),
            ),
            local({ seq: 4, createdAt: iso(30_000) }),
            local({ seq: 5, createdAt: iso(30_000 + GROUP_GAP_MS + 1) }),
        ];

        expect(kinds(messages)).toEqual([
            'day',
            'visitor[',
            'visitor]',
            'agent[]',
            'visitor[]',
            'visitor[]',
        ]);
    });

    it('lets system lines stand alone and keys pending messages by client id', () => {
        const messages = [
            toLocalMessage(
                makeSystemMessage({ seq: 1, createdAt: fakeTime(1) }),
            ),
            toLocalMessage(
                makeSystemMessage({ seq: 2, createdAt: fakeTime(2) }),
            ),
            makeLocalMessage({
                ulid: null,
                seq: null,
                clientMsgId: 'client-1',
                status: 'sending',
                createdAt: fakeTime(3),
            }),
        ];
        const entries = buildListEntries(messages);

        expect(kinds(messages)).toEqual([
            'day',
            'system[]',
            'system[]',
            'visitor[]',
        ]);
        expect(entries.at(-1)).toMatchObject({ key: 'client-1' });
    });

    it('is empty for no messages', () => {
        expect(buildListEntries([])).toEqual([]);
    });
});

describe('linkify', () => {
    it('keeps plain text as text', () => {
        expect(linkify('no links here')).toEqual([
            { kind: 'text', text: 'no links here' },
        ]);
        expect(linkify('')).toEqual([]);
    });

    it('splits out http and https links and trims trailing punctuation', () => {
        expect(
            linkify('See https://example.com/a?b=1, then http://x.test).'),
        ).toEqual([
            { kind: 'text', text: 'See ' },
            {
                kind: 'link',
                text: 'https://example.com/a?b=1',
                href: 'https://example.com/a?b=1',
            },
            { kind: 'text', text: ', then ' },
            { kind: 'link', text: 'http://x.test', href: 'http://x.test' },
            { kind: 'text', text: ').' },
        ]);
    });

    it('never links other schemes or markup', () => {
        const parts = linkify(
            'javascript:alert(1) <a href="https://evil.test">x</a> data:text/html,hi',
        );

        expect(
            parts
                .filter((part) => part.kind === 'link')
                .every((part) => part.href.startsWith('https://')),
        ).toBe(true);
        expect(parts.map((part) => part.text).join('')).toContain(
            'javascript:alert(1)',
        );
    });
});

describe('buildTranscript', () => {
    it('writes one line per delivered message, with attachments, and skips unsent ones', () => {
        const messages = [
            toLocalMessage(
                makeMessage({ seq: 1, body: 'Hello', createdAt: fakeTime(0) }),
            ),
            toLocalMessage(
                makeAgentMessage({
                    seq: 2,
                    body: 'Hi Vera',
                    createdAt: fakeTime(60),
                }),
            ),
            toLocalMessage(
                makeMessage({
                    seq: 3,
                    body: null,
                    type: 'image',
                    attachments: [makeAttachment()],
                    createdAt: fakeTime(120),
                }),
            ),
            toLocalMessage(
                makeSystemMessage({
                    seq: 4,
                    body: 'Chat ended',
                    createdAt: fakeTime(180),
                }),
            ),
            makeLocalMessage({
                ulid: null,
                seq: null,
                body: 'draft',
                status: 'failed',
            }),
        ];
        const lines = buildTranscript(messages, {
            locale: 'en',
            visitorName: 'Visitor',
            agentName: 'Agent',
            attachmentLabel: 'Image',
        }).split('\n');

        expect(lines).toHaveLength(4);
        expect(lines[0]).toMatch(/^\[.+\] Vera Visitor: Hello$/);
        expect(lines[1]).toMatch(/\] Sam: Hi Vera$/);
        expect(lines[2]).toMatch(/\] Vera Visitor: \[Image: image\/webp\]$/);
        expect(lines[3]).toMatch(/\] \*: Chat ended$/);
    });
});

describe('history query', () => {
    it('keeps only filled filters and a page above 1', () => {
        expect(historyQuery(NO_FILTERS)).toEqual({});
        expect(
            historyQuery(
                { ...NO_FILTERS, status: 'closed', q: ' hello ', agent: '4' },
                3,
            ),
        ).toEqual({
            status: 'closed',
            q: 'hello',
            agent: '4',
            page: '3',
        });
        expect(historyQuery({ ...NO_FILTERS, status: 'closed' }, 1)).toEqual({
            status: 'closed',
        });
    });

    it('knows whether a filter is on', () => {
        expect(hasActiveFilters(NO_FILTERS)).toBe(false);
        expect(hasActiveFilters({ ...NO_FILTERS, q: '  ' })).toBe(false);
        expect(hasActiveFilters({ ...NO_FILTERS, from: '2026-01-01' })).toBe(
            true,
        );
    });

    it('builds the export link of exactly the filtered set (no page)', () => {
        expect(exportUrl(NO_FILTERS)).toBe('/api/v1/conversations/export');
        expect(exportUrl({ ...NO_FILTERS, status: 'closed', q: 'a b' })).toBe(
            '/api/v1/conversations/export?status=closed&q=a+b',
        );
    });

    it('describes the visible window', () => {
        expect(pageWindow({ from: 26, to: 50, total: 312 })).toEqual({
            from: 26,
            to: 50,
            total: 312,
        });
        expect(pageWindow({ from: null, to: null, total: 0 })).toBeNull();
    });
});
