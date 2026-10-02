<?php

namespace App\Domain\Analytics;

/**
 * The columns of `analytics_daily` / `analytics_slots` and how they combine (docs/analytics.md). A counter is added up over days,
 * a maximum is combined with `max`; an average is never stored: it is `*_sum_s / *_count`, computed from the sums of the range, so it
 * stays exact for any range. The migration repeats these lists (it must not change when a later migration adds a column); a test pins them together.
 */
final class AnalyticsColumns
{
    /** Dimensions, in the order rows are written. `whatsapp` is administrator-only everywhere. */
    public const TOTAL = 'total';

    public const WIDGET = 'widget';

    public const CATEGORY = 'category';

    public const AGENT = 'agent';

    public const WHATSAPP = 'whatsapp';

    /** The dimensions a request can filter or break down by. */
    public const FILTERABLE = [self::WIDGET, self::CATEGORY, self::AGENT];

    /**
     * Live-chat and offline-ticket counters.
     *
     * @var list<string>
     */
    public const CHAT_COUNTERS = [
        'started', 'handled', 'reclaimed', 'transferred', 'missed',
        'ended', 'closed_rated', 'closed_skipped', 'closed_idle', 'closed_timeout', 'closed_system', 'closed_cancelled',
        'res_visitor', 'res_agent', 'res_system', 'res_idle',
        'wait_sum_s', 'wait_count', 'frt_sum_s', 'frt_count', 'handling_sum_s', 'handling_count', 'msgs_sum', 'msgs_count',
        'messages_visitor', 'messages_agent',
        'rating_count', 'rating_sum', 'rating_1', 'rating_2', 'rating_3', 'rating_4', 'rating_5',
        'offers',
        'offline_created', 'offline_answered', 'offline_response_sum_s', 'offline_closed',
    ];

    /**
     * WhatsApp counters (only the `whatsapp` dimension carries them).
     *
     * @var list<string>
     */
    public const WHATSAPP_COUNTERS = ['wa_chats_new', 'wa_chats_linked', 'wa_inbound', 'wa_outbound', 'wa_response_sum_s', 'wa_response_count'];

    /**
     * Every additive column of `analytics_daily`, in table order.
     *
     * @var list<string>
     */
    public const COUNTERS = [...self::CHAT_COUNTERS, ...self::WHATSAPP_COUNTERS];

    /**
     * Columns combined with `max` (a longest wait, the busiest moment), never added.
     *
     * @var list<string>
     */
    public const MAXIMA = ['wait_max_s', 'frt_max_s', 'handling_max_s', 'peak_concurrent', 'queue_peak'];

    /**
     * The slot table's counters.
     *
     * @var list<string>
     */
    public const SLOT_COUNTERS = ['started', 'claimed'];

    /** The grain of `analytics_slots` in seconds. */
    public const SLOT_SECONDS = 900;

    /**
     * @return list<string>
     */
    public static function all(): array
    {
        return [...self::COUNTERS, ...self::MAXIMA];
    }

    public static function isMaximum(string $column): bool
    {
        return in_array($column, self::MAXIMA, true);
    }
}
