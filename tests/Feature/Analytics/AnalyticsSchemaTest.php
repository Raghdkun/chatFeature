<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\AnalyticsColumns;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/** The tables and the indexes the rollup queries rely on (SQLite and MySQL). */
class AnalyticsSchemaTest extends TestCase
{
    use RefreshDatabase;

    public function test_analytics_daily_has_exactly_the_registry_columns(): void
    {
        $columns = Schema::getColumnListing('analytics_daily');
        $expected = ['id', 'date', 'dimension', 'dimension_key', 'tz', ...AnalyticsColumns::COUNTERS, ...AnalyticsColumns::MAXIMA, 'sealed_at', 'computed_at'];

        $this->assertEqualsCanonicalizing($expected, $columns);
        $this->assertEqualsCanonicalizing(['id', 'slot_start', 'dimension', 'dimension_key', ...AnalyticsColumns::SLOT_COUNTERS], Schema::getColumnListing('analytics_slots'));
    }

    public function test_a_day_dimension_and_key_exist_once(): void
    {
        DB::table('analytics_daily')->insert(['date' => '2026-03-10', 'dimension' => 'widget', 'dimension_key' => '4', 'tz' => 'UTC']);

        $this->expectException(UniqueConstraintViolationException::class);
        DB::table('analytics_daily')->insert(['date' => '2026-03-10', 'dimension' => 'widget', 'dimension_key' => '4', 'tz' => 'UTC']);
    }

    public function test_a_slot_dimension_and_key_exist_once(): void
    {
        DB::table('analytics_slots')->insert(['slot_start' => '2026-03-10 09:00:00', 'dimension' => 'total', 'dimension_key' => '']);

        $this->expectException(UniqueConstraintViolationException::class);
        DB::table('analytics_slots')->insert(['slot_start' => '2026-03-10 09:00:00', 'dimension' => 'total', 'dimension_key' => '']);
    }

    public function test_the_same_key_may_exist_in_another_dimension_and_on_another_day(): void
    {
        DB::table('analytics_daily')->insert(['date' => '2026-03-10', 'dimension' => 'widget', 'dimension_key' => '4', 'tz' => 'UTC']);
        DB::table('analytics_daily')->insert(['date' => '2026-03-10', 'dimension' => 'category', 'dimension_key' => '4', 'tz' => 'UTC']);
        DB::table('analytics_daily')->insert(['date' => '2026-03-11', 'dimension' => 'widget', 'dimension_key' => '4', 'tz' => 'UTC']);

        $this->assertSame(3, DB::table('analytics_daily')->count());
    }

    public function test_the_counters_default_to_zero_and_hold_big_sums(): void
    {
        DB::table('analytics_daily')->insert(['date' => '2026-03-10', 'dimension' => 'total', 'dimension_key' => '', 'tz' => 'UTC', 'wait_sum_s' => 5_000_000_000]);

        $row = DB::table('analytics_daily')->first();

        $this->assertSame(0, (int) $row->started);
        $this->assertSame(5_000_000_000, (int) $row->wait_sum_s);
        $this->assertNull($row->sealed_at);
    }

    /**
     * @return array<string, array{0: string, 1: string, 2: list<string>}>
     */
    public static function indexes(): array
    {
        return [
            'daily series' => ['analytics_daily', 'analytics_daily_series_index', ['dimension', 'dimension_key', 'date']],
            'daily unique' => ['analytics_daily', 'analytics_daily_unique', ['date', 'dimension', 'dimension_key']],
            'slot series' => ['analytics_slots', 'analytics_slots_series_index', ['dimension', 'dimension_key', 'slot_start']],
            'conversations by creation' => ['conversations', 'conversations_created_at_index', ['created_at']],
            'conversations by end' => ['conversations', 'conversations_ended_at_index', ['ended_at']],
            'conversations by close' => ['conversations', 'conversations_closed_at_index', ['closed_at']],
            'events by type and time' => ['conversation_events', 'conversation_events_type_created_index', ['type', 'created_at']],
            'messages by time' => ['messages', 'messages_created_at_index', ['created_at']],
            'ratings by time' => ['ratings', 'ratings_created_at_index', ['created_at']],
            'whatsapp chats by creation' => ['wa_chats', 'wa_chats_created_at_index', ['created_at']],
            'whatsapp messages by time' => ['wa_messages', 'wa_messages_timestamp_index', ['wa_timestamp']],
        ];
    }

    /**
     * @param  list<string>  $columns
     */
    #[DataProvider('indexes')]
    public function test_the_index_a_rollup_query_relies_on_exists(string $table, string $name, array $columns): void
    {
        $index = collect(Schema::getIndexes($table))->firstWhere('name', $name);

        $this->assertNotNull($index, "{$table}.{$name} is missing");
        $this->assertSame($columns, $index['columns']);
    }

    public function test_no_analytics_table_references_another(): void
    {
        $this->assertSame([], Schema::getForeignKeys('analytics_daily'));
        $this->assertSame([], Schema::getForeignKeys('analytics_slots'));
    }
}
