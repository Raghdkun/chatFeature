<?php

/*
|--------------------------------------------------------------------------
| Analytics (P7, docs/analytics.md)
|--------------------------------------------------------------------------
| Cache lifetimes are seconds; 0 turns a cache off (tests do). A rollup run changes the cache epoch, so a report never outlives a run.
*/
return [
    /** The widest range one request may cover. */
    'max_range_days' => 731,

    /** Today is computed on the spot; the result is kept this long (it is shared by every report of every viewer). */
    'live_ttl' => (int) env('ANALYTICS_LIVE_TTL', 30),

    /** A finished report that includes today / only finished days. */
    'report_ttl' => (int) env('ANALYTICS_REPORT_TTL', 60),
    'past_report_ttl' => (int) env('ANALYTICS_PAST_REPORT_TTL', 900),

    /** Past days nobody rolled up yet are computed on the spot, up to this many per request (the rest count as empty and are flagged). */
    'live_fill_days' => 14,

    /** The most recent ratings (with comments) the ratings report lists. */
    'recent_ratings' => 20,
];
