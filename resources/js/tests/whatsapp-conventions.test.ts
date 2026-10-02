/**
 * Guards for the conventions of the WhatsApp UI that are easy to break silently (administrators only, P6):
 *  - every translation key the screens use exists in lang/en.json (and the dynamic key families are complete, with plural pairs),
 *  - right-to-left safety: logical Tailwind utilities only,
 *  - a lint suppression always says why,
 *  - isolation: only the files that are meant to know about WhatsApp import its API client, its live store or its routes, so an agent's
 *    screens cannot start fetching WhatsApp data by accident.
 */
import { describe, expect, it } from 'vite-plus/test';
import type {
    SessionStatus,
    WaChatStatus,
    WaMessageStatus,
    WaMessageType,
} from '@/lib/whatsapp/types';
import { en } from '@/tests/lang';

const ui = import.meta.glob<string>(
    [
        '/resources/js/components/whatsapp/**/*.{ts,tsx}',
        '/resources/js/pages/whatsapp/**/*.tsx',
        '/resources/js/pages/settings/whatsapp.tsx',
        '/resources/js/components/widgets/builder/whatsapp-tab.tsx',
        '/resources/js/components/widgets/builder/use-whatsapp-link.ts',
        '/resources/js/nav/40-whatsapp.ts',
    ],
    { eager: true, query: '?raw', import: 'default' },
);
const logic = import.meta.glob<string>(
    [
        '/resources/js/lib/whatsapp-api/*.ts',
        '/resources/js/lib/whatsapp/*.ts',
        '/resources/js/lib/realtime/whatsapp/*.{ts,tsx}',
    ],
    { eager: true, query: '?raw', import: 'default' },
);
const everything = import.meta.glob<string>(
    ['/resources/js/**/*.{ts,tsx}', '!/resources/js/**/*.test.{ts,tsx}'],
    { eager: true, query: '?raw', import: 'default' },
);

const notTest = (entries: Record<string, string>): [string, string][] =>
    Object.entries(entries).filter(
        ([path]) =>
            !/\.test\.tsx?$/.test(path) &&
            !path.endsWith('/fixtures.ts') &&
            !path.includes('/resources/js/tests/'),
    );

const uiFiles = notTest(ui);
const logicFiles = notTest(logic);
const files = [...uiFiles, ...logicFiles];

describe('the scan itself', () => {
    it('sees the files of this area', () => {
        expect(uiFiles.length).toBeGreaterThan(25);
        expect(logicFiles.length).toBeGreaterThan(12);
        expect(files.some(([path]) => path.endsWith('chat-view.tsx'))).toBe(
            true,
        );
        expect(files.some(([path]) => path.endsWith('use-wa-chat.ts'))).toBe(
            true,
        );
        expect(files.some(([path]) => /\.test\.tsx?$/.test(path))).toBe(false);
    });
});

// Compile-time exhaustiveness: a value added to a generated enum without its label fails tsc here.
const SESSION_STATUSES = {
    created: true,
    starting: true,
    qr: true,
    ready: true,
    disconnected: true,
    failed: true,
} satisfies Record<SessionStatus, true>;
const CHAT_STATUSES = { open: true, archived: true } satisfies Record<
    WaChatStatus,
    true
>;
const MESSAGE_STATUSES = {
    pending: true,
    sent: true,
    delivered: true,
    read: true,
    failed: true,
    received: true,
} satisfies Record<WaMessageStatus, true>;
const MESSAGE_TYPES = {
    text: true,
    image: true,
    video: true,
    audio: true,
    voice: true,
    document: true,
    sticker: true,
    location: true,
    contact: true,
    other: true,
} satisfies Record<WaMessageType, true>;

describe('translations', () => {
    it('has every key the screens reference (plural keys via .one / .other)', () => {
        const missing: string[] = [];

        for (const [path, source] of files) {
            for (const match of source.matchAll(
                /'(whatsapp\.[A-Za-z0-9_.]+)'/g,
            )) {
                const key = match[1];

                if (!(key in en) && !(`${key}.other` in en)) {
                    missing.push(
                        `${key} (${path.split('/').slice(-2).join('/')})`,
                    );
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it('completes every dynamic key family', () => {
        const expected: string[] = [
            ...Object.keys(SESSION_STATUSES).map((s) => `whatsapp.status.${s}`),
            ...Object.keys(CHAT_STATUSES).map(
                (s) => `whatsapp.status.chat_${s}`,
            ),
            ...Object.keys(MESSAGE_STATUSES).map(
                (s) => `whatsapp.message.status.${s}`,
            ),
            ...Object.keys(MESSAGE_TYPES).map(
                (s) => `whatsapp.message.type.${s}`,
            ),
            ...['length', 'characters'].map(
                (n) => `whatsapp.session.name_${n}`,
            ),
            ...[
                'not_configured',
                'blocked',
                'unreachable',
                'unauthorized',
                'rejected',
                'unexpected_response',
                'other',
            ].flatMap((reason) => [
                `whatsapp.connection.reason.${reason}.title`,
                `whatsapp.connection.reason.${reason}.hint`,
            ]),
            // The error sentences: one per kind `describeWaError` can return.
            ...[
                'session_not_ready',
                'daily_cap',
                'pacing',
                'pacing_after',
                'not_inbound',
                'unreachable',
                'unauthorized_key',
                'webhook_rejected',
                'webhook_limit',
                'not_configured',
                'openwa_rejected',
                'session_state',
                'qr_not_available',
                'name_taken',
                'teardown_pending',
                'session_busy',
                'not_found',
            ].map((kind) => `whatsapp.error.${kind}`),
        ];

        expect(expected.filter((key) => !(key in en))).toEqual([]);
    });

    it('has both plural forms wherever one exists', () => {
        const bases = Object.keys(en)
            .filter(
                (key) => key.startsWith('whatsapp.') && key.endsWith('.one'),
            )
            .map((key) => key.slice(0, -4));

        expect(bases.length).toBeGreaterThanOrEqual(2);

        for (const base of bases) {
            expect(en, `${base}.other`).toHaveProperty([`${base}.other`]);
        }
    });

    it('keeps every whatsapp.* key well formed and non-empty', () => {
        const ours = Object.keys(en).filter((key) =>
            key.startsWith('whatsapp.'),
        );

        expect(ours.length).toBeGreaterThan(250);

        for (const key of ours) {
            expect(en[key].trim(), key).not.toBe('');
            expect(key, key).toMatch(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/);
        }
    });

    it('keeps interpolation placeholders consistent with how the screens call them', () => {
        const placeholders = (key: string) =>
            [...en[key].matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]).sort();

        expect(placeholders('whatsapp.error.pacing_after')).toEqual(['wait']);
        expect(placeholders('whatsapp.webhook.title')).toEqual(['name']);
        expect(placeholders('whatsapp.toast.webhook_reregistered')).toEqual([
            'name',
        ]);
        expect(placeholders('whatsapp.toast.session_created')).toEqual([
            'name',
        ]);
        expect(placeholders('whatsapp.stop.title')).toEqual(['name']);
        expect(placeholders('whatsapp.delete.title')).toEqual(['name']);
    });
});

describe('RTL: logical utilities only', () => {
    // margin/padding/position/text-align/rounded/border sides, floats and scroll margins.
    const PHYSICAL =
        /(?<![\w-])-?(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-(?:\d|\[|px|auto|full|1\/2|0\b)|(?<![\w-])text-(?:left|right)\b|(?<![\w-])(?:rounded|border)-(?:l|r|tl|tr|bl|br)(?:-|\b)|(?<![\w-])float-(?:left|right)\b|(?<![\w-])(?:float|clear):\s*(?:left|right)|(?<![\w-])(?:margin|padding)-(?:left|right)\s*:/;

    it('does not use ml-/mr-/pl-/pr-/left-/right-/text-left/text-right (or rounded-l/r, border-l/r, float)', () => {
        const offenders: string[] = [];

        for (const [path, source] of uiFiles) {
            source.split('\n').forEach((line, index) => {
                if (PHYSICAL.test(line)) {
                    offenders.push(
                        `${path.split('/').slice(-3).join('/')}:${index + 1}: ${line.trim()}`,
                    );
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    it('catches the patterns it is meant to catch', () => {
        for (const bad of [
            'ml-2',
            'pr-1',
            'left-0',
            '-ml-1',
            'text-left',
            'rounded-l-md',
            'border-r',
            'float-left',
        ]) {
            expect(PHYSICAL.test(`className="${bad}"`), bad).toBe(true);
        }

        for (const good of [
            'ms-2',
            'pe-1',
            'start-0',
            'text-start',
            'rounded-s-md',
            'border-e',
        ]) {
            expect(PHYSICAL.test(`className="${good}"`), good).toBe(false);
        }
    });

    it('writes a phone number, a session name and a code left-to-right inside right-to-left text', () => {
        const phone = uiFiles.find(([path]) =>
            path.endsWith('components/whatsapp/phone-number.tsx'),
        )?.[1];

        expect(phone).toContain('dir="ltr"');
    });
});

describe('lint suppressions', () => {
    it('always say why: a reason after "--" or a comment line right above', () => {
        const unexplained: string[] = [];

        for (const [path, source] of files) {
            const lines = source.split('\n');

            lines.forEach((line, index) => {
                if (
                    !/eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/.test(
                        line,
                    )
                ) {
                    return;
                }

                const same = /--\s*\S/.test(line);
                const above = /^\s*\/\/\s*\S/.test(lines[index - 1] ?? '');

                if (!same && !above) {
                    unexplained.push(
                        `${path.split('/').slice(-2).join('/')}:${index + 1}`,
                    );
                }
            });
        }

        expect(unexplained).toEqual([]);
    });

    it('never switches off type checking', () => {
        const offenders = files
            .filter(([, source]) =>
                /@ts-ignore|@ts-nocheck|@ts-expect-error/.test(source),
            )
            .map(([path]) => path);

        expect(offenders).toEqual([]);
    });
});

describe('isolation: WhatsApp stays an administrator feature', () => {
    // Who may know the WhatsApp API client, its routes and the live store. Everything else (the agent's inbox, history, the rest of
    // Settings, the visitor panel) must not: an agent's screens cannot start asking for WhatsApp data by accident.
    const allowed = [
        '/resources/js/components/whatsapp/',
        '/resources/js/pages/whatsapp/',
        '/resources/js/pages/settings/whatsapp.tsx',
        '/resources/js/components/widgets/builder/whatsapp-tab.tsx',
        '/resources/js/components/widgets/builder/use-whatsapp-link.ts',
        '/resources/js/lib/whatsapp-api/',
        '/resources/js/lib/whatsapp/',
        '/resources/js/lib/realtime/whatsapp/',
        '/resources/js/nav/40-whatsapp.ts',
        // The staff realtime host mounts the provider for administrators only; the settings sidebar shows the link to administrators only.
        '/resources/js/lib/realtime/staff/host.tsx',
        '/resources/js/layouts/settings/layout.tsx',
        '/resources/js/types/whatsapp.ts',
        '/resources/js/types/whatsapp.conformance.ts',
    ];
    // The pure type module (`@/lib/whatsapp/types`: short names of the generated Data classes) is shared with the visitor's hand-off call.
    const importer =
        /from\s+'@\/(?:lib\/(?:whatsapp-api|realtime\/whatsapp)[/']|lib\/whatsapp\/(?!types')|components\/whatsapp[/'])/;

    it('catches the imports it is meant to catch', () => {
        for (const bad of [
            "from '@/lib/whatsapp-api/client'",
            "from '@/lib/realtime/whatsapp/context'",
            "from '@/components/whatsapp/chat-view'",
            "from '@/lib/whatsapp/fixtures'",
        ]) {
            expect(importer.test(bad), bad).toBe(true);
        }

        expect(importer.test("from '@/lib/whatsapp/types'")).toBe(false);
        expect(importer.test("from '@/lib/chat/types'")).toBe(false);
    });

    it('is imported by nobody outside the allowed files', () => {
        const offenders = notTest(everything)
            .filter(([, source]) => importer.test(source))
            .map(([path]) => path)
            .filter(
                (path) => !allowed.some((prefix) => path.startsWith(prefix)),
            );

        expect(offenders).toEqual([]);
    });

    it('keeps the visitor panel and the loader free of the management client', () => {
        const embed = notTest(everything).filter(
            ([path]) =>
                path.startsWith('/resources/js/embed/') ||
                path.startsWith('/resources/widget/'),
        );

        expect(embed.length).toBeGreaterThan(40);
        expect(
            embed
                .filter(([, source]) =>
                    /whatsapp-api|realtime\/whatsapp|components\/whatsapp|waRoutes|lib\/whatsapp\/(?!types')/.test(
                        source,
                    ),
                )
                .map(([path]) => path),
        ).toEqual([]);
    });

    it('lists the nav entry for administrators only, in the sidebar group the other chat entries use', () => {
        const nav = files.find(([path]) => path.endsWith('nav/40-whatsapp.ts'));

        expect(nav?.[1]).toContain("role: 'admin'");
        expect(nav?.[1]).not.toContain("role: 'any'");
        expect(nav?.[1]).not.toContain("role: 'agent'");
    });
});
