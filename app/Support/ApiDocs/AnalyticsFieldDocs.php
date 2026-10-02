<?php

namespace App\Support\ApiDocs;

/**
 * The prose of the analytics response fields and request parameters (merged into {@see FieldDocs} and {@see RequestDocs}).
 */
final class AnalyticsFieldDocs
{
    /**
     * @return array<string, array<string, string>>
     */
    public static function fields(): array
    {
        return [
            'AnalyticsRangeData' => [
                'from' => 'First day (`Y-m-d`, application time zone).',
                'to' => 'Last day, inclusive.',
                'days' => 'Number of days in the range.',
            ],
            'AnalyticsScopeData' => [
                'role' => 'The caller\'s view: `admin` (the whole account) or `agent` (their own numbers only).',
                'dimension' => 'Which rollup rows were read: `total`, or one `widget`, `category` or `agent`.',
                'key' => 'The filter the caller asked for (widget / topic ulid, agent id); `null` for the total.',
                'whatsapp' => 'Whether the caller may read WhatsApp numbers (administrators only).',
            ],
            'AnalyticsMetaData' => [
                'timezone' => 'The application time zone the days are counted in.',
                'today' => 'Today in that zone.',
                'live' => 'The range includes today, which is computed on the spot with the same code as the rollup.',
                'rolledUpTo' => 'The last day with a stored rollup in the range; `null` when none.',
                'missingDays' => 'Past days nobody has rolled up that were NOT computed (up to 14 are computed on the spot; the rest count as empty): run `php artisan analytics:rollup`.',
                'timezoneChanged' => 'Stored days were counted in another time zone than the current setting: rebuild them with `analytics:rollup --force`.',
                'generatedAt' => 'When this answer was built (answers are cached for up to a minute).',
            ],
            'AnalyticsKpisData' => [
                'started' => 'Live chats visitors started. `null` for one agent.',
                'handled' => 'Chats an agent accepted for the first time.',
                'reclaimed' => 'Chats accepted again after a transfer or re-queue.',
                'transferred' => 'Chats an agent or admin handed on.',
                'missed' => 'Chats nobody accepted before the queue timeout. `null` for one agent.',
                'cancelled' => 'Chats the visitor left while queued. `null` for one agent.',
                'ended' => 'Chats either side ended.',
                'closed' => 'Chats that reached `closed`, whatever the reason. `null` for one agent.',
                'answerRate' => 'handled / (handled + missed), 0 to 1. `null` for one agent or when nothing was handled or missed.',
                'wait' => 'Queued to first accept (one sample per chat).',
                'firstResponse' => 'First accept to the first agent message.',
                'handling' => 'First accept to the end of the chat (to the close, when an agent had it and it was never ended).',
                'peakConcurrent' => 'Most chats active at the same instant (for one agent: their own).',
                'queuePeak' => 'Most chats queued at the same instant. `null` for one agent.',
                'resolution' => 'How handled chats finished.',
                'offline' => 'Offline tickets.',
                'offers' => 'Offers of queued chats to agents.',
            ],
            'AnalyticsDurationData' => [
                'averageSeconds' => 'Total seconds / samples of the range; `null` without samples.',
                'maxSeconds' => 'The longest sample.',
                'count' => 'Number of samples.',
            ],
            'AnalyticsRatingsData' => [
                'count' => 'Ratings given in the period.',
                'average' => 'Sum of scores / count; `null` without ratings.',
                'distribution' => 'Counts of 1, 2, 3, 4 and 5 stars, in that order.',
            ],
            'AnalyticsMessagesData' => [
                'visitor' => 'Messages visitors sent. `null` for one agent.',
                'agent' => 'Messages agents sent (for one agent: their own).',
                'perChat' => 'Visitor + agent messages per finished chat; `null` without finished chats.',
            ],
            'AnalyticsResolutionData' => [
                'visitor' => 'Ended by the visitor.',
                'agent' => 'Ended by an agent or an administrator.',
                'system' => 'Ended by the system, or closed by staff without an end.',
                'idle' => 'Closed by the idle sweep.',
            ],
            'AnalyticsOfflineData' => [
                'created' => 'Tickets left. `null` for one agent.',
                'answered' => 'Tickets that got a first agent reply.',
                'closed' => 'Tickets closed. `null` for one agent.',
                'averageResponseSeconds' => 'Creation to the first reply, on average.',
            ],
            'AnalyticsOffersData' => [
                'received' => 'Offers made (one per agent a queued chat was offered to).',
                'acceptRate' => '(handled + reclaimed) / offers, at most 1.',
            ],
            'AnalyticsPointData' => [
                'date' => 'First day of the bucket.',
                'value' => 'The metric over the bucket; `null` when there was nothing to average.',
                'days' => 'How many days of the bucket lie inside the requested range.',
            ],
            'AnalyticsSeriesData' => [
                'metric' => 'The metric name.',
                'unit' => '`count`, `seconds`, `score` (1 to 5) or `ratio` (0 to 1).',
            ],
            'AnalyticsTimeseriesData' => [
                'interval' => '`day`, `week` (Monday first) or `month`.',
            ],
            'AnalyticsBreakdownData' => [
                'by' => '`widget`, `category` or `agent`.',
            ],
            'AnalyticsBreakdownRowData' => [
                'key' => 'Widget / topic ulid or the agent\'s user id as text; `0` = no topic / nobody we can name.',
                'label' => 'Name, looked up now (a deleted one reads "Deleted widget", "Deleted topic" or "Deleted account").',
                'deleted' => 'The widget, topic or account no longer exists; its numbers stay.',
                'sparkline' => 'The row\'s volume over the period (chats started for a widget or topic, chats accepted for an agent), at most about 60 buckets.',
            ],
            'AnalyticsHeatmapData' => [
                'timezone' => 'The viewer\'s time zone the hours are in.',
                'metric' => '`started` or `claimed`.',
                'matrix' => '`matrix[weekday][hour]`: weekday 0 = Monday to 6 = Sunday, hour 0 to 23.',
                'max' => 'The largest cell.',
                'total' => 'The sum of all cells.',
            ],
            'AnalyticsRatingEntryData' => [
                'conversation' => 'Ulid of the rated conversation.',
                'comment' => 'The visitor\'s comment, as text (never HTML).',
                'widget' => 'Name of the widget.',
                'category' => 'Name of the topic; `null` without one.',
                'agent' => 'Name of the agent the chat is assigned to; `null` when nobody.',
            ],
            'AnalyticsRatingsReportData' => [
                'recent' => 'The latest ratings with their comments (20 at most). Empty for an agent.',
            ],
            'AnalyticsWhatsAppTotalsData' => [
                'chats' => 'New WhatsApp chats in the period.',
                'linkedChats' => 'Of those, chats matched to a widget visitor by a hand-off.',
                'linkedShare' => 'linkedChats / chats, 0 to 1; `null` without chats.',
                'inbound' => 'Messages received.',
                'outbound' => 'Messages sent (accepted by the gateway: not pending, not failed).',
                'averageResponseSeconds' => 'Average time from a customer message nobody had answered to the reply.',
                'responseCount' => 'Number of replies measured.',
            ],
            'AnalyticsWhatsAppPointData' => [
                'date' => 'First day of the bucket.',
                'chats' => 'New chats.',
            ],
            'AnalyticsWhatsAppData' => [
                'interval' => '`day`, `week` (Monday first) or `month`.',
            ],
        ];
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    public static function examples(): array
    {
        return [
            'AnalyticsRangeData' => ['from' => '2026-09-01', 'to' => '2026-09-30', 'days' => 30],
            'AnalyticsScopeData' => ['role' => 'admin', 'dimension' => 'total', 'key' => null],
            'AnalyticsMetaData' => ['today' => '2026-09-30', 'rolledUpTo' => '2026-09-29', 'missingDays' => 0, 'timezoneChanged' => false],
            'AnalyticsKpisData' => ['started' => 120, 'handled' => 100, 'reclaimed' => 4, 'transferred' => 4, 'missed' => 12, 'cancelled' => 8, 'ended' => 96, 'closed' => 110, 'answerRate' => 0.89, 'peakConcurrent' => 6, 'queuePeak' => 3],
            'AnalyticsDurationData' => ['averageSeconds' => 42.5, 'maxSeconds' => 180, 'count' => 100],
            'AnalyticsRatingsData' => ['count' => 40, 'average' => 4.4, 'distribution' => [1, 2, 4, 10, 23]],
            'AnalyticsMessagesData' => ['visitor' => 900, 'agent' => 1100, 'perChat' => 20.8],
            'AnalyticsResolutionData' => ['visitor' => 60, 'agent' => 30, 'system' => 4, 'idle' => 2],
            'AnalyticsOfflineData' => ['created' => 9, 'answered' => 7, 'closed' => 6, 'averageResponseSeconds' => 5400],
            'AnalyticsOffersData' => ['received' => 300, 'acceptRate' => 0.33],
            'AnalyticsPointData' => ['date' => '2026-09-28', 'value' => 12.0, 'days' => 1],
            'AnalyticsSeriesData' => ['metric' => 'started', 'unit' => 'count'],
            'AnalyticsTimeseriesData' => ['interval' => 'day'],
            'AnalyticsBreakdownData' => ['by' => 'category'],
            'AnalyticsBreakdownRowData' => ['key' => '01j9z3q8x7m5n2k4p6r8t0v1w4', 'label' => 'Billing', 'deleted' => false, 'sparkline' => [4, 7, 5, 9, 12, 8, 10]],
            'AnalyticsHeatmapData' => ['metric' => 'started', 'max' => 18, 'total' => 420, 'matrix' => self::matrix()],
            'AnalyticsRatingEntryData' => ['widget' => 'Main website', 'category' => 'Billing', 'agent' => 'Sam Rivera'],
            'AnalyticsWhatsAppTotalsData' => ['chats' => 30, 'linkedChats' => 12, 'linkedShare' => 0.4, 'inbound' => 210, 'outbound' => 180, 'averageResponseSeconds' => 840, 'responseCount' => 150],
            'AnalyticsWhatsAppPointData' => ['date' => '2026-09-28', 'chats' => 4, 'inbound' => 22, 'outbound' => 17, 'averageResponseSeconds' => 780],
            'AnalyticsWhatsAppData' => ['interval' => 'day'],
        ];
    }

    /**
     * Seven weekdays (Monday first) of 24 hours: quiet nights, a busy working day.
     *
     * @return list<list<int>>
     */
    private static function matrix(): array
    {
        $day = [0, 0, 0, 0, 0, 0, 1, 2, 5, 11, 14, 12, 9, 13, 18, 15, 10, 6, 3, 2, 1, 0, 0, 0];

        return [$day, $day, $day, $day, $day, array_map(fn (int $n): int => intdiv($n, 3), $day), array_map(fn (int $n): int => intdiv($n, 4), $day)];
    }

    /**
     * The query parameters of every analytics endpoint (one Form Request).
     *
     * @return array<string, array{description: string, example?: mixed}>
     */
    public static function request(): array
    {
        return [
            'from' => ['description' => 'First day (`Y-m-d`, application time zone, inclusive). Default: 29 days before `to`.', 'example' => '2026-09-01'],
            'to' => ['description' => 'Last day (`Y-m-d`, inclusive). Default and maximum: today. A range is at most 731 days.', 'example' => '2026-09-30'],
            'compare' => ['description' => '`1` also answers for the equally long period right before this one.', 'example' => true],
            'tz' => ['description' => 'The viewer\'s IANA time zone for the busiest-hours heatmap (default: the application\'s). Days are always counted in the application time zone.', 'example' => 'Europe/Berlin'],
            'widget' => ['description' => 'Narrow to one widget (ulid; deleted ones work). One of `widget`, `category`, `agent` at a time; not for agents.', 'example' => '01j9z3q8x7m5n2k4p6r8t0v1w5'],
            'category' => ['description' => 'Narrow to one topic (ulid; deleted ones work). One filter at a time; not for agents.', 'example' => '01j9z3q8x7m5n2k4p6r8t0v1w4'],
            'agent' => ['description' => 'Narrow to one agent (user id). An agent may only pass their own id (anyone else\'s is `403`).', 'example' => 7],
            'interval' => ['description' => 'Bucket size: `day`, `week` (Monday first) or `month`. Default: day up to 62 days, week up to 540, else month.', 'example' => 'day'],
            'metric' => ['description' => 'Timeseries: one to six comma-separated metrics (see the endpoint). Heatmap: `started` or `claimed`.', 'example' => 'started,handled,missed'],
            'by' => ['description' => 'Breakdown: split by `widget`, `category` or `agent`.', 'example' => 'category'],
            'format' => ['description' => 'Export only: `csv` (the only format).', 'example' => 'csv'],
        ];
    }
}
