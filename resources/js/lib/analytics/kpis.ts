/**
 * The headline cards: what each shows, how it is formatted, and which way is "better" (so a delta arrow can say good or bad in words, not
 * colour alone). An agent's own view gets its own list: the numbers that cannot belong to one agent are not offered.
 */
import type { Kpis, SeriesMetric, SeriesUnit } from '@/lib/analytics/types';

export type KpiId =
    | 'started'
    | 'handled'
    | 'missed'
    | 'wait'
    | 'firstResponse'
    | 'handling'
    | 'rating'
    | 'peak'
    | 'ended'
    | 'messages'
    | 'offers';

export type KpiDefinition = {
    id: KpiId;
    /** `analytics.kpi.<id>` and `analytics.kpi.<id>_hint` carry the texts. */
    unit: SeriesUnit;
    better: 'up' | 'down' | 'neutral';
    value: (kpis: Kpis) => number | null;
    /** The series the card's chart shortcut would show, when there is one. */
    metric?: SeriesMetric;
};

const seconds = (duration: Kpis['wait']): number | null =>
    duration.averageSeconds;

const DEFINITIONS: Record<KpiId, KpiDefinition> = {
    started: {
        id: 'started',
        unit: 'count',
        better: 'neutral',
        value: (k) => k.started,
        metric: 'started',
    },
    handled: {
        id: 'handled',
        unit: 'count',
        better: 'up',
        value: (k) => k.handled,
        metric: 'handled',
    },
    missed: {
        id: 'missed',
        unit: 'count',
        better: 'down',
        value: (k) => k.missed,
        metric: 'missed',
    },
    wait: {
        id: 'wait',
        unit: 'seconds',
        better: 'down',
        value: (k) => seconds(k.wait),
        metric: 'wait_avg',
    },
    firstResponse: {
        id: 'firstResponse',
        unit: 'seconds',
        better: 'down',
        value: (k) => seconds(k.firstResponse),
        metric: 'frt_avg',
    },
    handling: {
        id: 'handling',
        unit: 'seconds',
        better: 'neutral',
        value: (k) => seconds(k.handling),
        metric: 'handling_avg',
    },
    rating: {
        id: 'rating',
        unit: 'score',
        better: 'up',
        value: (k) => k.ratings.average,
        metric: 'rating_avg',
    },
    peak: {
        id: 'peak',
        unit: 'count',
        better: 'neutral',
        value: (k) => k.peakConcurrent,
        metric: 'peak_concurrent',
    },
    ended: {
        id: 'ended',
        unit: 'count',
        better: 'neutral',
        value: (k) => k.ended,
        metric: 'ended',
    },
    messages: {
        id: 'messages',
        unit: 'count',
        better: 'neutral',
        value: (k) => k.messages.agent,
        metric: 'messages_agent',
    },
    offers: {
        id: 'offers',
        unit: 'count',
        better: 'neutral',
        value: (k) => k.offers.received,
    },
};

export const ADMIN_KPIS: KpiDefinition[] = [
    'started',
    'handled',
    'missed',
    'wait',
    'firstResponse',
    'handling',
    'rating',
    'peak',
].map((id) => DEFINITIONS[id as KpiId]);

export const AGENT_KPIS: KpiDefinition[] = [
    'handled',
    'ended',
    'firstResponse',
    'handling',
    'rating',
    'messages',
    'peak',
    'offers',
].map((id) => DEFINITIONS[id as KpiId]);
