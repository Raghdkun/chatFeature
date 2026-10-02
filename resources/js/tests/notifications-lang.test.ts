/**
 * Every `notifications.*` string the code asks for exists in lang/en.json (the client's `t('...')` calls in the notification sources,
 * the keys built from a value at runtime, and the server's `trans('...')` calls in the push message builder), and the sentences keep
 * the placeholders their callers fill in.
 */
import { describe, expect, it } from 'vite-plus/test';
import { en } from '@/tests/lang';

const sources = import.meta.glob<string>(
    [
        '/resources/js/components/notifications/*.tsx',
        '/resources/js/pages/settings/notifications.tsx',
        '/resources/js/lib/notifications/*.ts',
        '/resources/js/layouts/settings/layout.tsx',
        '/app/Domain/Notifications/Services/PushMessages.php',
    ],
    { eager: true, query: '?raw', import: 'default' },
);

const keysIn = (source: string): string[] =>
    [
        ...source.matchAll(
            /\b(?:t|trans)\(\s*'(notifications\.[A-Za-z0-9_.]+)'/g,
        ),
    ].map((match) => match[1]);

const used = new Set(
    Object.entries(sources)
        .filter(([path]) => !path.endsWith('.test.ts'))
        .flatMap(([, source]) => keysIn(source)),
);

/** Keys looked up through a table or a variable (`t(UNSUPPORTED_KEYS[reason])`): listed here, each checked below. */
const dynamic = [
    'notifications.status.insecure',
    'notifications.status.no_service_worker',
    'notifications.status.no_push',
    'notifications.status.no_notification',
    'notifications.status.ios_needs_install',
];

describe('notifications lang keys', () => {
    it('finds the keys the sources use (the scan is not silently empty)', () => {
        expect(used.size).toBeGreaterThan(40);
        expect(used.has('notifications.push.offer_title')).toBe(true);
        expect(used.has('notifications.prompt.title')).toBe(true);
    });

    it('has an English sentence for every key the code asks for', () => {
        const missing = [...used, ...dynamic].filter(
            (key) => !(key in en) || en[key].trim() === '',
        );

        expect(missing).toEqual([]);
    });

    it('has no key that nothing uses', () => {
        const everything = new Set([...used, ...dynamic]);
        const unused = Object.keys(en).filter(
            (key) => key.startsWith('notifications.') && !everything.has(key),
        );

        expect(unused).toEqual([]);
    });

    it('keeps the placeholders the callers fill in', () => {
        expect(en['notifications.push.message_title']).toContain(':name');
        expect(en['notifications.prompt.note']).toContain(':days');
        expect(en['notifications.test.sent_many']).toContain(':count');
        expect(en['notifications.test.limited']).toContain(':seconds');
        expect(en['notifications.devices.added']).toContain(':date');
        expect(en['notifications.devices.last_used']).toContain(':date');
        expect(en['notifications.devices.remove_label']).toContain(':name');
    });

    it('uses only the notifications prefix for what this track added', () => {
        const added = Object.keys(en).filter((key) =>
            key.startsWith('notifications.'),
        );

        expect(added.length).toBeGreaterThan(80);
    });
});
