/**
 * A fake of the analytics API (`/api/v1/analytics/*`) as MSW handlers: the paths of `@/lib/analytics/routes`, the `{ data }` / `{ error }`
 * envelopes, the shapes of the generated Data types, and the scoping the real server applies (an agent's overview has `null` where a number
 * cannot belong to one agent; the breakdown, WhatsApp and export endpoints answer 403 to an agent). Every request is recorded, so a test can
 * assert what the page asked for ("an agent's screen never requests the WhatsApp numbers").
 */
import { delay, http, HttpResponse } from 'msw';
import { analyticsRoutes } from '@/lib/analytics/routes';
import type {
    AnalyticsRole,
    BreakdownData,
    BreakdownRow,
    HeatmapData,
    Kpis,
    MetaData,
    OverviewData,
    RatingsReport,
    SeriesMetric,
    SeriesUnit,
    TimeseriesData,
    WhatsAppReport,
} from '@/lib/analytics/types';

export type RecordedAnalyticsCall = {
    path: string;
    query: Record<string, string>;
};

const UNITS: Record<string, SeriesUnit> = {
    wait_avg: 'seconds',
    frt_avg: 'seconds',
    handling_avg: 'seconds',
    rating_avg: 'score',
};

export function makeKpis(overrides: Partial<Kpis> = {}): Kpis {
    return {
        started: 120,
        handled: 100,
        reclaimed: 4,
        transferred: 4,
        missed: 12,
        cancelled: 8,
        ended: 96,
        closed: 110,
        answerRate: 100 / 112,
        wait: { averageSeconds: 42.5, maxSeconds: 180, count: 100 },
        firstResponse: { averageSeconds: 25, maxSeconds: 90, count: 98 },
        handling: { averageSeconds: 612, maxSeconds: 3600, count: 96 },
        ratings: { count: 40, average: 4.4, distribution: [1, 2, 4, 10, 23] },
        messages: { visitor: 900, agent: 1100, perChat: 20.8 },
        peakConcurrent: 6,
        queuePeak: 3,
        resolution: { visitor: 60, agent: 30, system: 4, idle: 2 },
        offline: {
            created: 9,
            answered: 7,
            closed: 6,
            averageResponseSeconds: 5400,
        },
        offers: { received: 300, acceptRate: 0.33 },
        ...overrides,
    };
}

/** What the server leaves out of one agent's own numbers. */
export function agentKpis(kpis: Kpis): Kpis {
    return {
        ...kpis,
        started: null,
        missed: null,
        cancelled: null,
        closed: null,
        answerRate: null,
        queuePeak: null,
        messages: { ...kpis.messages, visitor: null },
        offline: { ...kpis.offline, created: null, closed: null },
    };
}

export function makeMeta(overrides: Partial<MetaData> = {}): MetaData {
    return {
        timezone: 'UTC',
        today: '2026-03-27',
        live: true,
        rolledUpTo: '2026-03-26',
        missingDays: 0,
        timezoneChanged: false,
        generatedAt: '2026-03-27T10:00:00.000Z',
        ...overrides,
    };
}

function days(from: string, to: string): string[] {
    const result: string[] = [];

    for (
        let day = new Date(`${from}T00:00:00Z`);
        day <= new Date(`${to}T00:00:00Z`);
        day = new Date(day.getTime() + 86_400_000)
    ) {
        result.push(day.toISOString().slice(0, 10));
    }

    return result;
}

export type AnalyticsBackendOptions = {
    role?: AnalyticsRole;
    /** Hold every answer back this long (ms): lets a test look at the loading state. */
    delay?: number;
    kpis?: Kpis;
    previous?: Kpis;
    meta?: Partial<MetaData>;
    breakdown?: Partial<
        Record<'widget' | 'category' | 'agent', BreakdownRow[]>
    >;
    recent?: RatingsReport['recent'];
};

export type AnalyticsBackend = {
    handlers: ReturnType<typeof http.get>[];
    calls: RecordedAnalyticsCall[];
    /** `callsTo('overview')` -> the recorded requests of that endpoint. */
    callsTo: (endpoint: string) => RecordedAnalyticsCall[];
    /** Make an endpoint fail: `status` for `times` requests (default: every request until `heal`). */
    fail: (endpoint: string, status: number, times?: number) => void;
    heal: (endpoint: string) => void;
    options: AnalyticsBackendOptions;
};

export function createAnalyticsBackend(
    options: AnalyticsBackendOptions = {},
): AnalyticsBackend {
    const role = options.role ?? 'admin';
    const calls: RecordedAnalyticsCall[] = [];
    const failures = new Map<string, { status: number; left: number }>();

    const record = (request: Request, endpoint: string) => {
        const url = new URL(request.url);

        calls.push({
            path: endpoint,
            query: Object.fromEntries(url.searchParams.entries()),
        });

        const failure = failures.get(endpoint);

        if (failure && failure.left !== 0) {
            failure.left -= 1;

            return HttpResponse.json(
                {
                    error: {
                        code:
                            failure.status === 403
                                ? 'forbidden'
                                : 'server_error',
                        message: 'No.',
                    },
                },
                { status: failure.status },
            );
        }

        return null;
    };

    const adminOnly = () =>
        role === 'agent'
            ? HttpResponse.json(
                  {
                      error: {
                          code: 'forbidden',
                          message: 'Only administrators can do this.',
                      },
                  },
                  { status: 403 },
              )
            : null;

    const scopeOf = (query: Record<string, string>) => {
        if (role === 'agent') {
            return { role, dimension: 'agent', key: '7', whatsapp: false };
        }

        const entry = (['widget', 'category', 'agent'] as const).find(
            (dimension) => query[dimension],
        );

        return {
            role,
            dimension: entry ?? 'total',
            key: entry ? query[entry] : null,
            whatsapp: true,
        };
    };

    const handlers = [
        http.get(analyticsRoutes.api.overview(), async ({ request }) => {
            if (options.delay) {
                await delay(options.delay);
            }

            const failed = record(request, 'overview');

            if (failed) {
                return failed;
            }

            const query = Object.fromEntries(new URL(request.url).searchParams);
            const scope = scopeOf(query);
            const base = options.kpis ?? makeKpis();
            const previousBase =
                options.previous ??
                makeKpis({
                    started: 100,
                    handled: 100,
                    missed: 15,
                    wait: { averageSeconds: 50, maxSeconds: 200, count: 90 },
                    firstResponse: {
                        averageSeconds: 25,
                        maxSeconds: 80,
                        count: 90,
                    },
                    ratings: {
                        count: 30,
                        average: 4.4,
                        distribution: [2, 3, 5, 8, 12],
                    },
                    peakConcurrent: 0,
                });
            const agentRow = scope.dimension === 'agent';
            const from = query.from ?? '2026-02-26';
            const to = query.to ?? '2026-03-27';
            const length = days(from, to).length;
            const previousEnd = new Date(
                new Date(`${from}T00:00:00Z`).getTime() - 86_400_000,
            );
            const previousStart = new Date(
                previousEnd.getTime() - (length - 1) * 86_400_000,
            );
            const data: OverviewData = {
                range: { from, to, days: length },
                previousRange: query.compare
                    ? {
                          from: previousStart.toISOString().slice(0, 10),
                          to: previousEnd.toISOString().slice(0, 10),
                          days: length,
                      }
                    : null,
                scope,
                current: agentRow ? agentKpis(base) : base,
                previous: query.compare
                    ? agentRow
                        ? agentKpis(previousBase)
                        : previousBase
                    : null,
                meta: makeMeta({ ...options.meta, live: to >= '2026-03-27' }),
            };

            return HttpResponse.json({ data });
        }),

        http.get(analyticsRoutes.api.timeseries(), async ({ request }) => {
            if (options.delay) {
                await delay(options.delay);
            }

            const failed = record(request, 'timeseries');

            if (failed) {
                return failed;
            }

            const query = Object.fromEntries(new URL(request.url).searchParams);
            const metrics = (query.metric ?? '')
                .split(',')
                .filter(Boolean) as SeriesMetric[];
            const dates = days(query.from, query.to);
            const data: TimeseriesData = {
                range: { from: query.from, to: query.to, days: dates.length },
                interval: query.interval,
                series: metrics.map((metric, index) => ({
                    metric,
                    unit: UNITS[metric] ?? 'count',
                    points: dates.map((date, position) => ({
                        date,
                        value:
                            metric === 'rating_avg'
                                ? 3.5 + (position % 3) * 0.5
                                : (position + 1) *
                                  (index + 1) *
                                  (UNITS[metric] === 'seconds' ? 10 : 1),
                        days: 1,
                    })),
                })),
                meta: makeMeta(options.meta),
            };

            return HttpResponse.json({ data });
        }),

        http.get(analyticsRoutes.api.breakdown(), async ({ request }) => {
            if (options.delay) {
                await delay(options.delay);
            }

            const failed = record(request, 'breakdown') ?? adminOnly();

            if (failed) {
                return failed;
            }

            const query = Object.fromEntries(new URL(request.url).searchParams);
            const by = query.by as 'widget' | 'category' | 'agent';
            const rows = options.breakdown?.[by] ?? [];
            const data: BreakdownData = {
                by,
                range: {
                    from: query.from,
                    to: query.to,
                    days: days(query.from, query.to).length,
                },
                rows,
                meta: makeMeta(options.meta),
            };

            return HttpResponse.json({ data });
        }),

        http.get(analyticsRoutes.api.heatmap(), async ({ request }) => {
            if (options.delay) {
                await delay(options.delay);
            }

            const failed = record(request, 'heatmap');

            if (failed) {
                return failed;
            }

            const query = Object.fromEntries(new URL(request.url).searchParams);
            const matrix = Array.from({ length: 7 }, (_, day) =>
                Array.from({ length: 24 }, (_, hour) =>
                    hour >= 9 && hour <= 17 && day < 5
                        ? (hour - 8) * (day + 1)
                        : 0,
                ),
            );
            const flat = matrix.flat();
            const data: HeatmapData = {
                timezone: query.tz ?? 'UTC',
                metric: query.metric ?? 'started',
                range: {
                    from: query.from,
                    to: query.to,
                    days: days(query.from, query.to).length,
                },
                matrix,
                max: Math.max(...flat),
                total: flat.reduce((sum, value) => sum + value, 0),
                meta: makeMeta(options.meta),
            };

            return HttpResponse.json({ data });
        }),

        http.get(analyticsRoutes.api.ratings(), async ({ request }) => {
            if (options.delay) {
                await delay(options.delay);
            }

            const failed = record(request, 'ratings');

            if (failed) {
                return failed;
            }

            const query = Object.fromEntries(new URL(request.url).searchParams);
            const kpis = options.kpis ?? makeKpis();
            const data: RatingsReport = {
                range: {
                    from: query.from,
                    to: query.to,
                    days: days(query.from, query.to).length,
                },
                ratings: kpis.ratings,
                recent:
                    role === 'agent'
                        ? []
                        : (options.recent ?? [
                              {
                                  conversation: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
                                  score: 5,
                                  comment: 'Fast and friendly <b>thanks</b>',
                                  createdAt: '2026-03-26T10:00:00.000Z',
                                  widget: 'Main site',
                                  category: 'Billing',
                                  agent: 'Sam',
                              },
                              {
                                  conversation: '01HZZZZZZZZZZZZZZZZZZZZZZ2',
                                  score: 2,
                                  comment: null,
                                  createdAt: '2026-03-25T10:00:00.000Z',
                                  widget: 'Main site',
                                  category: null,
                                  agent: null,
                              },
                          ]),
                meta: makeMeta(options.meta),
            };

            return HttpResponse.json({ data });
        }),

        http.get(analyticsRoutes.api.whatsapp(), async ({ request }) => {
            if (options.delay) {
                await delay(options.delay);
            }

            const failed = record(request, 'whatsapp') ?? adminOnly();

            if (failed) {
                return failed;
            }

            const query = Object.fromEntries(new URL(request.url).searchParams);
            const dates = days(query.from, query.to);
            const data: WhatsAppReport = {
                range: { from: query.from, to: query.to, days: dates.length },
                previousRange: null,
                interval: query.interval,
                current: {
                    chats: 30,
                    linkedChats: 12,
                    linkedShare: 0.4,
                    inbound: 210,
                    outbound: 180,
                    averageResponseSeconds: 840,
                    responseCount: 150,
                },
                previous: null,
                series: dates.map((date, index) => ({
                    date,
                    chats: index,
                    inbound: index * 3,
                    outbound: index * 2,
                    averageResponseSeconds: 600,
                })),
                meta: makeMeta(options.meta),
            };

            return HttpResponse.json({ data });
        }),
    ];

    return {
        handlers,
        calls,
        callsTo: (endpoint) => calls.filter((call) => call.path === endpoint),
        fail: (endpoint, status, times = -1) =>
            failures.set(endpoint, { status, left: times }),
        heal: (endpoint) => failures.delete(endpoint),
        options,
    };
}

export function makeBreakdownRow(
    overrides: Partial<BreakdownRow> & { key: string; label: string },
): BreakdownRow {
    return {
        deleted: false,
        kpis: makeKpis(),
        sparkline: [1, 3, 2, 5, 4, 6, 3],
        ...overrides,
    };
}

/** A 26-character id in the shape of a ULID (widgets and topics are addressed by ulid). */
export function ulidLike(prefix: string, n: number): string {
    return (
        prefix.padEnd(8, 'X') +
        String(n).padStart(26 - Math.max(prefix.length, 8), '0')
    );
}
