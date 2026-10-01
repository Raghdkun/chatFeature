/**
 * Static guards over the agent dashboard's sources: translations exist (and none is left unused), CSS is logical (RTL), animations
 * respect reduced motion, the contract's test ids are present, and the sidebar entries are what the roles expect.
 */
import { describe, expect, it } from 'vite-plus/test';
import { inNavGroup, navFor } from '@/nav';

const en = Object.values(
    import.meta.glob<Record<string, string>>('/lang/en.json', {
        eager: true,
        import: 'default',
    }),
)[0];

const sources = import.meta.glob<string>(
    [
        '/resources/js/components/inbox/*.{ts,tsx}',
        '!/resources/js/components/inbox/*.test.*',
        '/resources/js/pages/inbox/*.tsx',
        '/resources/js/pages/history/*.tsx',
        '/resources/js/pages/offline-tickets/*.tsx',
        '/resources/js/lib/realtime/staff/*.{ts,tsx}',
        '!/resources/js/lib/realtime/staff/*.test.*',
        '/resources/js/lib/chat-api/staff.ts',
        '/resources/js/nav/30-chat.ts',
    ],
    { query: '?raw', import: 'default', eager: true },
);

const entries = Object.entries(sources);
const joined = entries.map(([, source]) => source).join('\n');

const staticKeys = (source: string): string[] =>
    [
        ...source.matchAll(
            /\b(?:t|has|plural|translate)\(\s*'([A-Za-z0-9_.-]+)'/g,
        ),
    ].map((m) => m[1]);

const PLURAL = /\bplural\(\s*'([A-Za-z0-9_.-]+)'/g;

/** Keys built from a value at runtime, enumerated (a new value in the union needs a line here, or the test says so). */
const dynamicKeys = (): string[] => [
    ...['end', 'close'].flatMap((mode) =>
        ['open', 'title', 'body', 'confirm'].map(
            (part) => `inbox.${mode}.${part}`,
        ),
    ),
    ...['queued', 'ended', 'closed', 'missed', 'not_yours'].map(
        (status) => `inbox.composer.disabled.${status}`,
    ),
    ...['all', 'unread', 'active', 'finished'].map(
        (filter) => `inbox.filter.${filter}`,
    ),
    ...['sending', 'sent', 'delivered', 'seen', 'failed'].map(
        (status) => `inbox.message.status.${status}`,
    ),
    'inbox.message.not_sent',
    ...['offline', 'capacity', 'unavailable'].map(
        (reason) => `inbox.transfer.reason.${reason}`,
    ),
    ...[
        'too_long',
        'rejected',
        'forbidden',
        'closed',
        'rate_limited',
        'network',
    ].map((failure) => `inbox.message.failed.${failure}`),
    ...['online', 'away', 'offline'].map(
        (status) => `inbox.presence.${status}`,
    ),
    ...['queued', 'active', 'ended', 'closed', 'missed'].map(
        (status) => `inbox.status.${status}`,
    ),
    ...['live', 'offline'].map((type) => `inbox.type.${type}`),
];

const pluralBases = [...joined.matchAll(PLURAL)].map((m) => m[1]);
const pluralKeys = pluralBases.flatMap((base) => [
    `${base}.one`,
    `${base}.other`,
]);

const OWN_PREFIXES = ['inbox.', 'history.', 'tickets.'];

describe('translations', () => {
    it('finds the sources it scans', () => {
        expect(entries.length).toBeGreaterThan(40);
    });

    it('has English text for every literal and runtime key the dashboard uses', () => {
        const used = [...staticKeys(joined), ...dynamicKeys(), ...pluralKeys];
        const literal = used.filter((key) => !pluralBases.includes(key));

        expect(literal.filter((key) => !(key in en))).toEqual([]);
    });

    it('has the singular and plural form of every counted phrase', () => {
        expect(pluralBases.length).toBeGreaterThan(2);

        for (const base of pluralBases) {
            expect(en[`${base}.one`], `${base}.one`).toBeTruthy();
            expect(en[`${base}.other`], `${base}.other`).toBeTruthy();
        }
    });

    it('keeps no key under its prefixes that nothing uses', () => {
        const used = new Set([
            ...staticKeys(joined),
            ...dynamicKeys(),
            ...pluralKeys,
            'inbox.nav',
            'tickets.nav',
            'history.nav',
        ]);
        const unused = Object.keys(en).filter(
            (key) =>
                OWN_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
                !used.has(key),
        );

        expect(unused).toEqual([]);
    });

    it('never leaves an empty string, and never uses an em dash in copy', () => {
        const own = Object.entries(en).filter(([key]) =>
            OWN_PREFIXES.some((prefix) => key.startsWith(prefix)),
        );

        expect(own.filter(([, value]) => value.trim() === '')).toEqual([]);
        expect(
            own.filter(
                ([, value]) => value.includes('—') || value.includes('--'),
            ),
        ).toEqual([]);
    });
});

describe('RTL and motion', () => {
    const physical = [
        /(?:^|[\s"'`:])-?(?:ml|mr|pl|pr)-\S/,
        /(?:^|[\s"'`:])-?(?:left|right)-\S/,
        /(?:^|[\s"'`:])text-(?:left|right)\b/,
        /(?:^|[\s"'`:])border-(?:l|r)(?:-|\s|"|'|`)/,
        /(?:^|[\s"'`:])rounded-(?:l|r|tl|tr|bl|br)(?:-|\s|"|'|`)/,
        /(?:^|[\s"'`:])float-(?:left|right)\b/,
        /(?:^|[\s"'`:])space-x-/,
    ];

    it('uses logical utilities only (start / end), never left / right', () => {
        const hits: string[] = [];

        for (const [path, source] of entries) {
            source.split('\n').forEach((line, index) => {
                if (
                    line.trim().startsWith('//') ||
                    line.trim().startsWith('*')
                ) {
                    return;
                }

                for (const pattern of physical) {
                    if (pattern.test(line)) {
                        hits.push(
                            `${path.split('/').pop()}:${index + 1}: ${line.trim()}`,
                        );
                    }
                }
            });
        }

        expect(hits).toEqual([]);
    });

    it('flips directional icons in RTL', () => {
        const arrows = [
            'ArrowLeft',
            'ChevronLeft',
            'ChevronRight',
            'SendHorizontal',
            'MessageSquareReply',
        ];

        for (const [path, source] of entries.filter(([, s]) =>
            /<(ArrowLeft|ChevronLeft|ChevronRight|SendHorizontal)\b/.test(s),
        )) {
            for (const arrow of arrows) {
                for (const match of source.matchAll(
                    new RegExp(`<${arrow}\\b[^>]*>`, 'g'),
                )) {
                    expect(
                        match[0],
                        `${path.split('/').pop()} ${arrow}`,
                    ).toContain('rtl:-scale-x-100');
                }
            }
        }
    });

    it('respects reduced motion wherever something animates', () => {
        const animated =
            /(["'`])([^"'`]*?\banimate-(?:in|out|pulse|spin)\b[^"'`]*?)\1/g;
        const offenders: string[] = [];

        for (const [path, source] of entries) {
            for (const match of source.matchAll(animated)) {
                if (!match[2].includes('motion-reduce:')) {
                    offenders.push(`${path.split('/').pop()}: ${match[2]}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});

describe('the contract', () => {
    it('renders every test id of docs/contracts/chat-ui-p4.md (agent dashboard)', () => {
        const ids = [
            'inbox-queue',
            'offer-',
            'offer-accept-',
            'inbox-mine',
            'chat-row-',
            'chat-unseen-',
            'conversation-view',
            'message-list',
            'composer-input',
            'composer-send',
            'composer-attach',
            'end-chat',
            'transfer-chat',
            'presence-select',
        ];

        for (const id of ids) {
            expect(joined, id).toMatch(
                new RegExp(`data-testid=(?:"|\\{\`)${id}`),
            );
        }
    });
});

describe('sidebar entries', () => {
    const titles = (flags: { is_admin?: boolean; is_agent?: boolean }) =>
        inNavGroup(navFor(flags), 'main').map((item) => item.title);

    it('gives agents Inbox and Offline tickets after the dashboard, and admins History as well', () => {
        expect(titles({ is_agent: true })).toEqual([
            'Dashboard',
            'Inbox',
            'Offline tickets',
        ]);
        expect(titles({ is_admin: true })).toEqual([
            'Dashboard',
            'Inbox',
            'Offline tickets',
            'History',
        ]);
        expect(titles({})).toEqual(['Dashboard']);
    });

    it('links to the pages, with translatable titles and live badges on the first two', () => {
        const items = inNavGroup(navFor({ is_admin: true }), 'main').slice(1);

        expect(items.map((item) => item.href)).toEqual([
            '/inbox',
            '/offline-tickets',
            '/history',
        ]);
        expect(items.map((item) => Boolean(item.badge))).toEqual([
            true,
            true,
            false,
        ]);

        for (const item of items) {
            expect(en[item.titleKey as string]).toBe(item.title);
        }
    });

    it('keeps the administration group exactly as it was', () => {
        expect(
            inNavGroup(navFor({ is_admin: true }), 'admin').map(
                (item) => item.title,
            ),
        ).toEqual(['Widgets', 'Categories', 'Agents']);
    });
});
