/**
 * Guards for the conventions of this area that are easy to break silently:
 *  - every translation key the screens use exists in lang/en.json (and the dynamic key families are complete),
 *  - only the allowed key prefixes were added (parallel-merge rule: widgets.* categories.* agents.* builder.*),
 *  - no physical-direction Tailwind utilities (RTL), no lint suppressions.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
    BUILDER_TABS,
    builderTabLabelKey,
    DOMAIN_PROBLEM_KEYS,
    LIVE_SLICES,
} from '@/components/widgets/builder-state';
import { CATEGORY_ICON_KEYS } from '@/components/categories/category-visuals';
import { TEXT_KEYS } from '@/lib/widget-config';
import { en } from '@/tests/lang';

const sources = import.meta.glob<string>(
    [
        '/resources/js/components/{widgets,categories,agents}/**/*.{ts,tsx}',
        '/resources/js/pages/{widgets,categories,agents}/**/*.tsx',
        '/resources/js/pages/settings/support-categories.tsx',
        '/resources/js/lib/{api-client,widgets-routes,widget-config}.ts',
        '/resources/js/nav/1[0-2]-*.ts',
    ],
    { eager: true, query: '?raw', import: 'default' },
);

const files = Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
);

describe('the scan itself', () => {
    it('sees the files of this area', () => {
        expect(files.length).toBeGreaterThan(40);
        expect(files.some(([path]) => path.endsWith('builder-state.ts'))).toBe(
            true,
        );
        expect(
            files.some(([path]) => path.endsWith('pages/agents/index.tsx')),
        ).toBe(true);
        expect(files.some(([path]) => path.endsWith('.test.ts'))).toBe(false);
    });
});

/** `t('a.b')`, `plural('a.b', n)` and any other quoted key of our prefixes. */
function referencedKeys(): Map<string, string> {
    const keys = new Map<string, string>();

    for (const [path, source] of files) {
        for (const match of source.matchAll(
            /'((?:builder|widgets|categories|agents)\.[A-Za-z0-9_.]+)'/g,
        )) {
            keys.set(match[1], path);
        }
    }

    return keys;
}

describe('translations', () => {
    it('has every key the screens reference (plural keys via .one / .other)', () => {
        const missing = [...referencedKeys()]
            .filter(([key]) => !(key in en) && !(`${key}.other` in en))
            .map(
                ([key, path]) =>
                    `${key} (${path.split('/').slice(-2).join('/')})`,
            );

        expect(missing).toEqual([]);
    });

    it('has both plural forms wherever one exists', () => {
        const bases = new Set(
            Object.keys(en)
                .filter((key) => key.endsWith('.one'))
                .map((key) => key.slice(0, -4)),
        );

        for (const base of bases) {
            expect(en, `${base}.other`).toHaveProperty([`${base}.other`]);
        }

        expect(bases.size).toBeGreaterThanOrEqual(7);
    });

    it('completes every dynamic key family', () => {
        const expected: string[] = [
            ...CATEGORY_ICON_KEYS.map((key) => `categories.icon.${key}`),
            ...TEXT_KEYS.map((key) => `builder.texts.key.${key}`),
            ...BUILDER_TABS.map((tab) => builderTabLabelKey(tab)),
            ...['php', 'node', 'python'].map(
                (code) => `builder.embed.lang_${code}`,
            ),
            ...['sm', 'md', 'lg'].map(
                (size) => `builder.branding.size_${size}`,
            ),
            ...['aaa', 'aa', 'large', 'fail'].map(
                (grade) => `builder.contrast.${grade}`,
            ),
            ...['session', 'interval', 'never'].map(
                (policy) => `builder.greetings.dismiss_${policy}_hint`,
            ),
            ...['auto_hours', 'always_online', 'always_offline'].flatMap(
                (mode) => [`builder.mode.${mode}`, `builder.mode.${mode}_hint`],
            ),
            ...['name', 'email', 'phone'].map(
                (field) => `builder.prechat.field_${field}`,
            ),
            ...[
                'attachments',
                'rating',
                'sounds',
                'preChat',
                'offlineForm',
                'endChatByVisitor',
                'titleBadge',
                'whatsapp',
                'poweredBy',
            ].flatMap((feature) => [
                `builder.features.${feature}`,
                `builder.features.${feature}_hint`,
            ]),
            ...Object.values(DOMAIN_PROBLEM_KEYS),
            // The save message names the live slices it reached.
            ...LIVE_SLICES.map((slice) => `builder.slice.${slice}`),
        ];

        expect(expected.filter((key) => !(key in en))).toEqual([]);
    });

    it("only adds keys under this area's prefixes and stays flat (no empty values)", () => {
        const own = /^(widgets|categories|agents|builder)\./;
        const ours = Object.keys(en).filter((key) => own.test(key));

        // Not asserting what other phases own; just that ours are well-formed and plentiful.
        expect(ours.length).toBeGreaterThan(400);

        for (const key of ours) {
            expect(en[key].trim(), key).not.toBe('');
            expect(key, key).toMatch(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/);
        }
    });

    it('keeps interpolation placeholders consistent with how the screens call them', () => {
        const placeholders = (text: string) =>
            [...text.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]);

        expect(placeholders(en['builder.general.idle_hint']).sort()).toEqual([
            'default',
            'minutes',
        ]);
        expect(placeholders(en['builder.validation.range']).sort()).toEqual([
            'max',
            'min',
        ]);
        expect(placeholders(en['categories.delete.body']).sort()).toEqual([
            'agents',
            'widgets',
        ]);
        expect(placeholders(en['agents.count_filtered']).sort()).toEqual([
            'shown',
            'total',
        ]);
        expect(placeholders(en['builder.publish.done'])).toEqual(['version']);
    });

    it('explains the idle timeout the way the product defines it', () => {
        expect(en['builder.general.idle_hint']).toBe(
            'Chat closes after :minutes minutes without messages. Default: :default.',
        );
    });
});

describe('RTL: logical utilities only', () => {
    // margin/padding/position/text-align/rounded/border sides, floats and scroll margins.
    const PHYSICAL =
        /(?<![\w-])-?(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-(?:\d|\[|px|auto|full|1\/2|0\b)|(?<![\w-])text-(?:left|right)\b|(?<![\w-])(?:rounded|border)-(?:l|r|tl|tr|bl|br)(?:-|\b)|(?<![\w-])float-(?:left|right)\b|(?<![\w-])(?:float|clear):\s*(?:left|right)|(?<![\w-])(?:margin|padding)-(?:left|right)\s*:/;

    it('does not use ml-/mr-/pl-/pr-/left-/right-/text-left/text-right (or rounded-l/r, border-l/r, float)', () => {
        const offenders: string[] = [];

        for (const [path, source] of files) {
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
            'mr-4',
            'pl-3',
            'pr-1',
            'left-0',
            'right-2',
            '-ml-1',
            'text-left',
            'text-right',
            'rounded-l-md',
            'rounded-r',
            'border-l-2',
            'float-left',
            'left-[10px]',
        ]) {
            expect(PHYSICAL.test(`className="${bad}"`), bad).toBe(true);
        }

        for (const good of [
            'ms-2',
            'me-4',
            'ps-3',
            'pe-1',
            'start-0',
            'end-2',
            '-ms-1',
            'text-start',
            'text-end',
            'rounded-s-md',
            'border-s-2',
            'bg-left-top',
        ]) {
            expect(PHYSICAL.test(`className="${good}"`), good).toBe(false);
        }
    });
});

describe('no lint suppressions', () => {
    it('does not disable any rule in the files of this area', () => {
        const offenders = files
            .filter(([, source]) =>
                /eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/.test(
                    source,
                ),
            )
            .map(([path]) => path);

        expect(offenders).toEqual([]);
    });
});
