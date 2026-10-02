/**
 * Guards for the conventions of the analytics screens that are easy to break silently:
 *  - every translation key the screens use exists in lang/en.json (static keys and the dynamic families, with both plural forms),
 *  - only `analytics.*` keys were added by this track, all well-formed,
 *  - no physical-direction Tailwind utilities (RTL), no lint suppressions beyond the one effect pattern the repo already uses,
 *  - nothing in the page or the components writes to the server (analytics is read-only).
 */
import { describe, expect, it } from 'vite-plus/test';
import { ADMIN_KPIS, AGENT_KPIS } from '@/lib/analytics/kpis';
import { PRESETS } from '@/lib/analytics/ranges';
import { en } from '@/tests/lang';

const sources = import.meta.glob<string>(
    [
        '/resources/js/components/analytics/**/*.{ts,tsx}',
        '/resources/js/pages/analytics/**/*.tsx',
        '/resources/js/lib/analytics/*.ts',
        '/resources/js/nav/50-analytics.ts',
        '/resources/js/types/analytics.ts',
    ],
    { eager: true, query: '?raw', import: 'default' },
);

const files = Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
);

const metrics = [
    'started',
    'handled',
    'missed',
    'ended',
    'wait_avg',
    'frt_avg',
    'handling_avg',
    'rating_avg',
];
const hasPlural = (key: string) => `${key}.one` in en && `${key}.other` in en;

describe('the scan itself', () => {
    it('sees the files of this area', () => {
        expect(files.length).toBeGreaterThan(20);
        expect(
            files.some(([path]) => path.endsWith('pages/analytics/index.tsx')),
        ).toBe(true);
        expect(
            files.some(([path]) =>
                path.endsWith('components/analytics/heatmap.tsx'),
            ),
        ).toBe(true);
        expect(files.some(([path]) => path.endsWith('.test.ts'))).toBe(false);
    });
});

describe('translations', () => {
    it('has every key the screens reference (plural keys via .one / .other)', () => {
        const missing: string[] = [];

        for (const [path, source] of files) {
            for (const match of source.matchAll(
                /'(analytics\.[A-Za-z0-9_.]+)'/g,
            )) {
                const key = match[1];

                if (!(key in en) && !hasPlural(key)) {
                    missing.push(
                        `${key} (${path.split('/').slice(-2).join('/')})`,
                    );
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it('completes every dynamic key family', () => {
        const expected = [
            ...PRESETS.map((preset) => `analytics.filters.preset.${preset}`),
            ...['invalid', 'order', 'long'].map(
                (problem) => `analytics.filters.problem.${problem}`,
            ),
            ...['widget', 'category', 'agent'].map(
                (key) => `analytics.filters.${key}`,
            ),
            ...[...ADMIN_KPIS, ...AGENT_KPIS].map(
                (kpi) => `analytics.kpi.${kpi.id}`,
            ),
            ...metrics.map((metric) => `analytics.series.${metric}`),
            ...['better', 'worse'].map(
                (verdict) => `analytics.delta.${verdict}`,
            ),
            ...['started', 'claimed'].flatMap((metric) => [
                `analytics.heatmap.metric.${metric}`,
                `analytics.heatmap.label_${metric}`,
            ]),
            ...['category', 'widget', 'agent'].flatMap((by) => [
                `analytics.breakdown.by_${by}`,
                `analytics.breakdown.caption_${by}`,
            ]),
            ...['chats', 'linked', 'inbound', 'outbound', 'response'].map(
                (id) => `analytics.whatsapp.kpi.${id}`,
            ),
            ...['inbound', 'outbound'].map(
                (id) => `analytics.whatsapp.series.${id}`,
            ),
        ];

        expect(expected.filter((key) => !(key in en))).toEqual([]);

        const plurals = [
            'analytics.notice.missing',
            'analytics.kpi.ratings_count',
            'analytics.delta.vs',
            'analytics.ratings.from',
            'analytics.ratings.star',
            'analytics.heatmap.cell_started',
            'analytics.heatmap.cell_claimed',
        ];

        expect(plurals.filter((key) => !hasPlural(key))).toEqual([]);
    });

    it('only adds analytics.* keys of this track, flat and non-empty', () => {
        const ours = Object.keys(en).filter((key) =>
            key.startsWith('analytics.'),
        );

        expect(ours.length).toBeGreaterThan(120);

        for (const key of ours) {
            expect(en[key].trim(), key).not.toBe('');
            expect(key, key).toMatch(/^analytics(\.[A-Za-z0-9_]+)+$/);
        }
    });

    it('keeps the interpolation placeholders in step with how the screens call them', () => {
        const placeholders = (text: string) =>
            [...text.matchAll(/:([A-Za-z_]+)/g)]
                .map((match) => match[1])
                .sort();

        expect(placeholders(en['analytics.chart.summary'])).toEqual([
            'last',
            'max',
            'min',
            'series',
        ]);
        expect(placeholders(en['analytics.sparkline'])).toEqual([
            'first',
            'last',
            'peak',
        ]);
        expect(
            placeholders(en['analytics.heatmap.cell_started.other']),
        ).toEqual(['count', 'day', 'hour']);
        expect(placeholders(en['analytics.delta.up'])).toEqual(['value']);
        expect(placeholders(en['analytics.description'])).toEqual(['timezone']);
        expect(placeholders(en['analytics.notice.missing.other'])).toEqual([
            'count',
        ]);
    });
});

describe('the code', () => {
    it('uses logical CSS only (RTL): no left / right / ml / mr / pl / pr / text-left|right / border-l|r', () => {
        const physical =
            /(?:^|[\s"'`:])(?:-?(?:ml|mr|pl|pr)-(?:\d|\[|\()|-?(?:left|right)-(?:\d|\[|\()|text-(?:left|right)\b|border-[lr]\b|border-[lr]-\d|rounded-[lr]\b|rounded-[lr]-)/;
        const offenders = files
            .filter(([, source]) => physical.test(source))
            .map(([path]) => path.split('/').slice(-2).join('/'));

        expect(offenders).toEqual([]);
    });

    it('suppresses nothing but the repo\'s own "mirror an external value" effect rule', () => {
        const suppressions = files.flatMap(([path, source]) =>
            [
                ...source.matchAll(
                    /(eslint-disable[^\n]*|@ts-ignore|@ts-expect-error|@ts-nocheck)/g,
                ),
            ].map((match) => `${path.split('/').pop()}: ${match[1]}`),
        );

        expect(
            suppressions.every((line) =>
                line.includes('react-hooks/set-state-in-effect'),
            ),
        ).toBe(true);
    });

    it('never writes to the server: the client only has GET calls', () => {
        const writes = files
            .filter(
                ([path]) =>
                    path.includes('lib/analytics/client.ts') ||
                    path.includes('components/analytics') ||
                    path.includes('pages/analytics'),
            )
            .filter(([, source]) =>
                /\.(post|put|patch|delete)\(|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(
                    source,
                ),
            )
            .map(([path]) => path);

        expect(writes).toEqual([]);
    });

    it('renders no raw HTML: names and comments are text', () => {
        const offenders = files
            .filter(([, source]) =>
                /dangerouslySetInnerHTML|innerHTML\s*=/.test(source),
            )
            .map(([path]) => path);

        expect(offenders).toEqual([]);
    });
});
