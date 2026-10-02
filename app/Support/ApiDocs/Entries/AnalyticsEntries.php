<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Analytics\AnalyticsBreakdownData;
use App\Data\Analytics\AnalyticsHeatmapData;
use App\Data\Analytics\AnalyticsOverviewData;
use App\Data\Analytics\AnalyticsRatingsReportData;
use App\Data\Analytics\AnalyticsTimeseriesData;
use App\Data\Analytics\AnalyticsWhatsAppData;
use App\Domain\Analytics\AnalyticsColumns;
use App\Support\ApiDocs\Doc;

/**
 * Analytics (P7): numbers about chats, response times, ratings and WhatsApp, read from the daily rollups. Every staff member may call
 * the scoped endpoints, but the SERVER decides what they get: an agent only ever reads their own numbers.
 */
final class AnalyticsEntries implements EntryList
{
    private const GROUP = 'Analytics';

    private const SCOPE = "**Who sees what.** The server scopes every request by the caller's role. An **administrator** reads the whole account, optionally narrowed by **one** of `widget`, `category` or `agent` (two filters at once is `422`: the rollups hold one row per widget, topic or agent, not their crossings). An **agent** only ever reads their own numbers: `agent=<their own id>` is the same as no filter, `agent=<someone else>` is `403 forbidden`, `widget` / `category` is `422`, and the numbers that cannot belong to one agent (chats started, missed, cancelled, closed, the queue, offline tickets created or closed, the visitors' message count, the answer rate) are `null`. An agent never receives a colleague's name, a WhatsApp number or a visitor's comment.";

    private const DAYS = "**Days** are calendar days of the application time zone (`meta.timezone`), `from` and `to` inclusive; `to` is clamped to today and a range is at most 731 days. Counts and sums are stored per day and added up, so an average over a range is always the range's total seconds over the range's samples. Today is computed live; `meta` says how fresh the rest is.";

    public static function docs(): array
    {
        $columns = AnalyticsColumns::all();
        $row = array_fill_keys($columns, 0);
        $row = array_merge($row, ['started' => 12, 'handled' => 10, 'missed' => 2, 'ended' => 9, 'closed_rated' => 4, 'res_visitor' => 6, 'res_agent' => 3, 'wait_sum_s' => 420, 'wait_count' => 10, 'wait_max_s' => 95, 'frt_sum_s' => 240, 'frt_count' => 10, 'handling_sum_s' => 5400, 'handling_count' => 9, 'messages_visitor' => 61, 'messages_agent' => 74, 'rating_count' => 4, 'rating_sum' => 18, 'rating_5' => 2, 'rating_4' => 2, 'peak_concurrent' => 3, 'queue_peak' => 2, 'offers' => 24]);
        $csvHeader = implode(',', ['date', 'dimension', 'key', 'label', 'timezone', ...$columns]);
        $csvRow = implode(',', ['2026-09-29', 'total', '', '', 'Europe/Berlin', ...array_values($row)]);

        return [
            Doc::route('api.analytics.overview')
                ->in(self::GROUP)
                ->title('Key numbers of a period')
                ->about(self::SCOPE."\n\n".self::DAYS."\n\nThe headline numbers of the period in `current` and, with `compare=1`, of the equally long period right before it in `previous` (`previousRange`). `wait` is queued to accepted, `firstResponse` first accept to the first agent message, `handling` first accept to the end of the chat; each is `{ averageSeconds, maxSeconds, count }` and `averageSeconds` is `null` when nothing was measured. `answerRate` is handled / (handled + missed). `ratings.distribution` lists the counts of 1 to 5 stars in that order. `resolution` says how handled chats finished.")
                ->item(AnalyticsOverviewData::class)
                ->without('tz', 'interval', 'metric', 'by', 'format')
                ->errors([
                    'forbidden' => 'An agent asked for another agent\'s numbers (`agent=<other id>`).',
                    'validation_failed' => 'A date is not a real calendar date, `from` is after `to`, the range is longer than 731 days, two filters were combined, an agent used `widget` / `category`, or a ulid is unknown.',
                ]),

            Doc::route('api.analytics.timeseries')
                ->in(self::GROUP)
                ->title('Metrics over time')
                ->about(self::SCOPE."\n\n".self::DAYS."\n\nOne to six comma-separated `metric`s bucketed by `interval` (`day`, `week` starting on Monday, `month`; default chosen by the range: up to 62 days a day, up to 540 a week, else a month). A bucket is the sum of its days **inside the range** (`days` says how many), so the first and last bucket of a week or month can be partial. `unit` is `count`, `seconds`, `score` (1 to 5) or `ratio` (0 to 1); `value` is `null` when there was nothing to average.\n\nMetrics: `started`, `handled`, `reclaimed`, `transferred`, `missed`, `cancelled`, `ended`, `closed`, `answer_rate`, `wait_avg`, `wait_max`, `frt_avg`, `frt_max`, `handling_avg`, `handling_max`, `rating_avg`, `rating_count`, `messages_visitor`, `messages_agent`, `messages_per_chat`, `peak_concurrent`, `queue_peak`, `offline_created`, `offline_answered`, `offline_closed`, `offline_response_avg`, `offers`, `offer_accept_rate`, `res_visitor`, `res_agent`, `res_system`, `res_idle`. For one agent (an agent's own view, or an administrator filtering by an agent) `started`, `missed`, `cancelled`, `closed`, `answer_rate`, `queue_peak`, `offline_created` and `offline_closed` are `422`.")
                ->item(AnalyticsTimeseriesData::class)
                ->without('compare', 'tz', 'by', 'format')
                ->errors([
                    'forbidden' => 'An agent asked for another agent\'s numbers (`agent=<other id>`).',
                    'validation_failed' => 'An unknown or missing `metric` (or more than six), an unknown `interval`, a bad range or filter, or a metric that does not exist for one agent.',
                ]),

            Doc::route('api.analytics.breakdown')
                ->in(self::GROUP)
                ->title('Split by topic, widget or agent')
                ->about("Every topic, widget or agent that had activity in the period, busiest first (chats started for a widget or topic, chats accepted for an agent), each with its `kpis` (the same shape as the overview; an agent row has the agent-scope `null`s) and a `sparkline` of its volume (at most about 60 buckets). `key` is the widget or topic **ulid** or the agent's user id as text; `0` is \"No topic\" / \"Unassigned\". `deleted: true` marks a widget, topic or account that no longer exists: its numbers stay, under a generic name. **The whole account**: filters are not applied, so this is the menu of what to filter by.\n\n".self::DAYS)
                ->item(AnalyticsBreakdownData::class)
                ->without('compare', 'tz', 'widget', 'category', 'agent', 'interval', 'metric', 'format')
                ->errors(['validation_failed' => '`by` is missing or not `widget`, `category` or `agent`, or the range is invalid.']),

            Doc::route('api.analytics.heatmap')
                ->in(self::GROUP)
                ->title('Busiest hours')
                ->about(self::SCOPE."\n\n".self::DAYS."\n\nCounts by weekday and hour of the **viewer's** time zone (`tz`, default: the application's): `matrix[weekday][hour]`, weekday `0` = Monday to `6` = Sunday, hour `0` to `23`. The counts are kept per 15-minute UTC slot and moved into `tz` one slot at a time, so DST days and half-hour zones are exact. `metric` is `started` (chats started, the default) or `claimed` (chats accepted); an agent, and an administrator filtering by an agent, only have `claimed`.")
                ->item(AnalyticsHeatmapData::class)
                ->without('compare', 'interval', 'by', 'format')
                ->errors([
                    'forbidden' => 'An agent asked for another agent\'s numbers (`agent=<other id>`).',
                    'validation_failed' => '`metric` is not `started` or `claimed` (or `started` for one agent), `tz` is not a time zone, or the range / filter is invalid.',
                ]),

            Doc::route('api.analytics.ratings')
                ->in(self::GROUP)
                ->title('Ratings')
                ->about(self::SCOPE."\n\n".self::DAYS."\n\n`ratings` is the count, the average and the 1 to 5 distribution of the period. `recent` (the latest 20 ratings of the period with their comments, the conversation ulid, widget, topic and agent) is **administrators only**: an agent gets `[]`, because visitors' ratings and comments are an administrator record; the agent still gets the numbers about their own chats.")
                ->item(AnalyticsRatingsReportData::class)
                ->without('compare', 'tz', 'interval', 'metric', 'by', 'format')
                ->errors([
                    'forbidden' => 'An agent asked for another agent\'s numbers (`agent=<other id>`).',
                    'validation_failed' => 'The range or a filter is invalid.',
                ]),

            Doc::route('api.analytics.whatsapp')
                ->in(self::GROUP)
                ->title('WhatsApp numbers')
                ->about("New WhatsApp chats, how many came from a hand-off in the widget (`linkedShare`), messages received and sent, and the average response time (an outbound message answers the oldest inbound message nobody answered yet). `current` is the period, `previous` the equally long one before it with `compare=1`; `series` is bucketed by `interval`. WhatsApp numbers are administrator data everywhere: an agent never gets them.\n\n".self::DAYS)
                ->item(AnalyticsWhatsAppData::class)
                ->without('tz', 'metric', 'by', 'format', 'widget', 'category', 'agent')
                ->errors(['validation_failed' => 'An unknown `interval` or an invalid range.']),

            Doc::route('api.analytics.export')
                ->in(self::GROUP)
                ->title('Export the daily numbers')
                ->about("The stored daily rows of the period as CSV, streamed in a single pass (flat memory): one line per day, dimension and key, with the raw counters, sums of seconds and maxima (an average is `*_sum_s / *_count`, so the file never carries a figure that cannot be added up). `dimension` is `total`, `widget`, `category`, `agent` or `whatsapp`; `key` is the widget / topic / agent **id** (`0`: none) and `label` its name. A filter restricts the file to that one row. Today is the live computation; past days nobody has rolled up are not in the file (`X-Analytics-Missing-Days` counts them: run `analytics:rollup`). Cells that start like a formula (`=`, `+`, `-`, `@`, tab, CR) are prefixed with a quote. The export is recorded in the audit log (`analytics.exported`: format, period and dimension, never the file).\n\n".self::DAYS)
                ->raw(200, 'text/csv; charset=utf-8', $csvHeader."\n".$csvRow."\n", 'A CSV file.', ['Content-Disposition' => 'attachment; filename="analytics-20260930-120000.csv"', 'Cache-Control' => 'no-store', 'X-Analytics-Missing-Days' => '0'])
                ->without('compare', 'tz', 'interval', 'metric', 'by')
                ->errors(['validation_failed' => 'The range or a filter is invalid, or `format` is not `csv`.']),
        ];
    }
}
