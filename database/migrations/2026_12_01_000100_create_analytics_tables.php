<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Analytics rollups (P7, docs/analytics.md).
 *
 * `analytics_daily`: one row per (date, dimension, dimension_key). `date` is the day in the application time zone (`tz` says which: a
 * changed time zone is detectable, a rebuild fixes it), `dimension` is `total` / `widget` / `category` / `agent` / `whatsapp` and
 * `dimension_key` the id as text (`''` for `total` and `whatsapp`, `0` for "none": a chat without a topic, an unknown agent). The metric
 * columns are counts, sums of seconds and maxima, never averages, so any range can be added up and an average stays exact. There are
 * no foreign keys on purpose: a rollup row holds numbers, not references, so deleting a widget, a topic, an agent or a WhatsApp chat
 * never changes history. `sealed_at` (on the `total` row) marks a day that is final: only `--force` recomputes it.
 *
 * `analytics_slots`: the same dimensions at a 15-minute grain (UTC instants) for the busiest-hours heatmap, which the API re-buckets
 * into the viewer's time zone (every real UTC offset is a multiple of 15 minutes, so the result is exact).
 *
 * The extra indexes serve the rollup queries: each family reads one day of one table by its timestamp.
 */
return new class extends Migration
{
    /**
     * Additive metrics (counts and sums of seconds), in the order of `AnalyticsColumns::COUNTERS` (a test pins the two together;
     * the lists live here too so this migration never changes when a later one adds a metric).
     *
     * @var list<string>
     */
    private const COUNTERS = [
        'started', 'handled', 'reclaimed', 'transferred', 'missed', 'ended', 'closed_rated', 'closed_skipped', 'closed_idle',
        'closed_timeout', 'closed_system', 'closed_cancelled', 'res_visitor', 'res_agent', 'res_system', 'res_idle',
        'wait_sum_s', 'wait_count', 'frt_sum_s', 'frt_count', 'handling_sum_s', 'handling_count', 'msgs_sum', 'msgs_count',
        'messages_visitor', 'messages_agent', 'rating_count', 'rating_sum', 'rating_1', 'rating_2', 'rating_3', 'rating_4',
        'rating_5', 'offers', 'offline_created', 'offline_answered', 'offline_response_sum_s', 'offline_closed', 'wa_chats_new',
        'wa_chats_linked', 'wa_inbound', 'wa_outbound', 'wa_response_sum_s', 'wa_response_count',
    ];

    /** @var list<string> Maxima (combined with `max`, never added). */
    private const MAXIMA = ['wait_max_s', 'frt_max_s', 'handling_max_s', 'peak_concurrent', 'queue_peak'];

    /** @var list<string> */
    private const SLOT_COUNTERS = ['started', 'claimed'];

    public function up(): void
    {
        Schema::create('analytics_daily', function (Blueprint $table) {
            $table->id();
            $table->date('date');
            $table->string('dimension', 16);
            $table->string('dimension_key', 40)->default('');
            $table->string('tz', 64);

            foreach (self::COUNTERS as $column) {
                $table->unsignedBigInteger($column)->default(0);
            }

            foreach (self::MAXIMA as $column) {
                $table->unsignedInteger($column)->default(0);
            }

            $table->timestamp('sealed_at')->nullable();
            $table->timestamp('computed_at')->nullable();

            $table->unique(['date', 'dimension', 'dimension_key'], 'analytics_daily_unique');
            $table->index(['dimension', 'dimension_key', 'date'], 'analytics_daily_series_index');
        });

        Schema::create('analytics_slots', function (Blueprint $table) {
            $table->id();
            $table->timestamp('slot_start');
            $table->string('dimension', 16);
            $table->string('dimension_key', 40)->default('');

            foreach (self::SLOT_COUNTERS as $column) {
                $table->unsignedInteger($column)->default(0);
            }

            $table->unique(['slot_start', 'dimension', 'dimension_key'], 'analytics_slots_unique');
            $table->index(['dimension', 'dimension_key', 'slot_start'], 'analytics_slots_series_index');
        });

        Schema::table('conversations', function (Blueprint $table) {
            $table->index('created_at', 'conversations_created_at_index');
            $table->index('ended_at', 'conversations_ended_at_index');
            $table->index('closed_at', 'conversations_closed_at_index');
        });

        Schema::table('conversation_events', function (Blueprint $table) {
            $table->index(['type', 'created_at'], 'conversation_events_type_created_index');
        });

        Schema::table('messages', function (Blueprint $table) {
            $table->index('created_at', 'messages_created_at_index');
        });

        Schema::table('ratings', function (Blueprint $table) {
            $table->index('created_at', 'ratings_created_at_index');
        });

        Schema::table('wa_chats', function (Blueprint $table) {
            $table->index('created_at', 'wa_chats_created_at_index');
        });

        Schema::table('wa_messages', function (Blueprint $table) {
            $table->index('wa_timestamp', 'wa_messages_timestamp_index');
        });
    }

    public function down(): void
    {
        Schema::table('wa_messages', fn (Blueprint $table) => $table->dropIndex('wa_messages_timestamp_index'));
        Schema::table('wa_chats', fn (Blueprint $table) => $table->dropIndex('wa_chats_created_at_index'));
        Schema::table('ratings', fn (Blueprint $table) => $table->dropIndex('ratings_created_at_index'));
        Schema::table('messages', fn (Blueprint $table) => $table->dropIndex('messages_created_at_index'));
        Schema::table('conversation_events', fn (Blueprint $table) => $table->dropIndex('conversation_events_type_created_index'));
        Schema::table('conversations', function (Blueprint $table) {
            $table->dropIndex('conversations_closed_at_index');
            $table->dropIndex('conversations_ended_at_index');
            $table->dropIndex('conversations_created_at_index');
        });

        Schema::dropIfExists('analytics_slots');
        Schema::dropIfExists('analytics_daily');
    }
};
