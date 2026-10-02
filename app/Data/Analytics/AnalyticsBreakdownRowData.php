<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * One widget, topic or agent of a breakdown. `key` is the widget / topic ulid or the agent's user id (`0` = chats without a topic, activity
 * of an agent nobody can name any more); `deleted` marks a widget, topic or account that no longer exists (its history stays). `sparkline` is
 * the row's volume over the range (chats started for a widget or topic, chats handled for an agent), at most about 60 buckets.
 */
#[TypeScript]
class AnalyticsBreakdownRowData extends Data
{
    /**
     * @param  list<int>  $sparkline
     */
    public function __construct(
        public string $key,
        public string $label,
        public bool $deleted,
        public AnalyticsKpisData $kpis,
        public array $sparkline,
    ) {}
}
