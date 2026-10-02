<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\Actions\RollupDay;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\AnalyticsWorld;
use Tests\Support\AssertsAnalytics;
use Tests\TestCase;

/**
 * The metric definitions of docs/analytics.md, one story each, with the numbers worked out by hand. (The reconciliation test proves the
 * rollup and the independent reference agree on a large dataset; this one proves what the definitions ARE.)
 */
class RollupDefinitionsTest extends TestCase
{
    use AssertsAnalytics, RefreshDatabase;

    private AnalyticsWorld $world;

    private Widget $widget;

    private Category $billing;

    private User $ann;

    private User $bob;

    protected function setUp(): void
    {
        parent::setUp();

        $this->widget = Widget::factory()->create();
        $this->billing = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $this->world = new AnalyticsWorld($this->widget, $this->billing);
        $this->ann = User::factory()->agent()->create(['name' => 'Ann']);
        $this->bob = User::factory()->agent()->create(['name' => 'Bob']);
    }

    /**
     * @return array<string, int>
     */
    private function day(string $date, string $dimension = 'total', string $key = ''): array
    {
        app(RollupDay::class)->handle($date, true, 'UTC');

        return $this->storedRows($date)[$dimension][$key] ?? [];
    }

    public function test_a_chat_that_goes_well_is_counted_on_the_day_of_each_of_its_events(): void
    {
        $this->world->chat('2026-03-10 09:00:00')
            ->offeredTo([$this->ann, $this->bob])
            ->visitorSays(5, 'Hi, I need help')
            ->claimedBy($this->ann, 35)             // 09:00:40: wait 40 s
            ->agentSays(15, 'Hello')                 // 09:00:55: first response 15 s after the claim
            ->visitorSays(20, 'Thanks')
            ->agentSays(10, 'Anything else?')
            ->endedBy('visitor', 555)                // 09:10:40: handling 600 s
            ->rated(5, 80)                           // 09:12:00
            ->save();

        $total = $this->day('2026-03-10');

        $this->assertEquals([
            'started' => 1, 'handled' => 1, 'ended' => 1, 'closed_rated' => 1, 'res_visitor' => 1,
            'wait_sum_s' => 40, 'wait_count' => 1, 'wait_max_s' => 40,
            'frt_sum_s' => 15, 'frt_count' => 1, 'frt_max_s' => 15,
            'handling_sum_s' => 600, 'handling_count' => 1, 'handling_max_s' => 600,
            'msgs_sum' => 4, 'msgs_count' => 1, 'messages_visitor' => 2, 'messages_agent' => 2,
            'rating_count' => 1, 'rating_sum' => 5, 'rating_5' => 1, 'offers' => 2,
            'peak_concurrent' => 1, 'queue_peak' => 1,
        ], $total);

        // Ann's row: what she did (accepted, answered, finished, was rated); not the visitor-side numbers (started).
        $ann = $this->day('2026-03-10', 'agent', (string) $this->ann->id);
        $this->assertSame(1, $ann['handled']);
        $this->assertSame(1, $ann['ended']);
        $this->assertSame(2, $ann['messages_agent']);
        $this->assertSame(1, $ann['rating_count']);
        $this->assertSame(1, $ann['offers']);
        $this->assertArrayNotHasKey('started', $ann);
        $this->assertArrayNotHasKey('messages_visitor', $ann);

        // Bob was offered the chat and nothing else.
        $this->assertEquals(['offers' => 1], $this->day('2026-03-10', 'agent', (string) $this->bob->id));
    }

    public function test_a_chat_that_spans_midnight_counts_each_event_on_its_own_day(): void
    {
        $this->world->chat('2026-03-10 23:58:00')
            ->claimedBy($this->ann, 180)             // 00:01:00 on the 11th: wait 180 s
            ->agentSays(30)                           // 00:01:30: first response 30 s
            ->endedBy('agent', 1170)                  // 00:21:00: handling 1200 s
            ->rated(4, 60)
            ->save();

        $first = $this->day('2026-03-10');
        $second = $this->day('2026-03-11');

        $this->assertEquals(['started' => 1, 'queue_peak' => 1], $first);
        $this->assertSame(1, $second['handled']);
        $this->assertSame(180, $second['wait_sum_s']);
        $this->assertSame(30, $second['frt_sum_s']);
        $this->assertSame(1200, $second['handling_sum_s']);
        $this->assertSame(1, $second['res_agent']);
        $this->assertSame(1, $second['rating_4']);
        $this->assertSame(1, $second['peak_concurrent']);
        $this->assertArrayNotHasKey('started', $second);
    }

    public function test_a_transferred_chat_has_one_wait_and_one_first_response_but_two_claims(): void
    {
        $this->world->chat('2026-03-10 10:00:00')
            ->offeredTo([$this->ann])
            ->claimedBy($this->ann, 20)               // wait 20 s (the only wait: re-claims do not measure one)
            ->agentSays(10)                            // first response 10 s, Ann's
            ->transferredTo($this->bob, null, 100)    // 10:02:10: Ann hands it to Bob (a direct offer to him)
            ->claimedBy($this->bob, 30)               // 10:02:40
            ->agentSays(5, 'Bob here', $this->bob)    // not a first response again
            ->endedBy('agent', 300)                   // 10:07:45
            ->save();

        $total = $this->day('2026-03-10');

        $this->assertSame(1, $total['handled']);
        $this->assertSame(1, $total['reclaimed']);
        $this->assertSame(1, $total['transferred']);
        $this->assertSame(20, $total['wait_sum_s']);
        $this->assertSame(1, $total['frt_count']);
        $this->assertSame(10, $total['frt_sum_s']);
        $this->assertSame(2, $total['offers'], 'the wave offer to Ann and the direct offer to Bob');
        // Handling runs from the FIRST claim (10:00:20) to the end (10:07:45), and belongs to the agent who finished it.
        $this->assertSame(445, $total['handling_sum_s']);
        $this->assertSame(1, $this->day('2026-03-10', 'agent', (string) $this->ann->id)['transferred']);
        $this->assertSame(1, $this->day('2026-03-10', 'agent', (string) $this->bob->id)['ended']);
        $this->assertSame(1, $this->day('2026-03-10', 'agent', (string) $this->bob->id)['reclaimed']);
        // Ann and Bob never had it at the same time; the queue was never more than one chat deep.
        $this->assertSame(1, $total['peak_concurrent']);
    }

    public function test_missed_cancelled_idle_and_staff_closed_chats_are_counted_apart(): void
    {
        $this->world->chat('2026-03-10 11:00:00')->missed(90)->save();
        $this->world->chat('2026-03-10 11:05:00')->closed('cancelled', 30, 'visitor')->save();
        $this->world->chat('2026-03-10 11:10:00')->claimedBy($this->ann, 10)->closed('idle', 7200)->save();
        $this->world->chat('2026-03-10 11:20:00')->closed('system', 60, 'admin')->save();      // staff dismissed a queued chat: never handled
        $this->world->chat('2026-03-10 11:30:00')->claimedBy($this->bob, 10)->closed('system', 400, 'admin')->save();

        $total = $this->day('2026-03-10');

        $this->assertSame(5, $total['started']);
        $this->assertSame(1, $total['missed']);
        $this->assertSame(1, $total['closed_cancelled']);
        $this->assertSame(1, $total['closed_idle']);
        $this->assertSame(2, $total['closed_system']);
        $this->assertSame(2, $total['handled']);
        // Resolution: only chats an agent had. The idle one and the one staff closed; the dismissed queued chat was never handled.
        $this->assertSame(1, $total['res_idle']);
        $this->assertSame(1, $total['res_system']);
        $this->assertArrayNotHasKey('ended', $total, 'closed from active is not an end');
        $this->assertSame(2, $total['handling_count']);
        $this->assertSame(7200 + 400, $total['handling_sum_s']);
    }

    public function test_an_offline_ticket_is_answered_and_closed_on_later_days(): void
    {
        $this->world->ticket('2026-03-10 20:00:00')
            ->visitorSays(0, 'Please call me')
            ->claimedBy($this->ann, 86400 + 3600)      // 11th 21:00
            ->agentSays(600, 'Called you')             // 11th 21:10: 1 day 1 h 10 min after the ticket
            ->closed('system', 60, 'agent', $this->ann->id) // closed on the 11th
            ->save();

        $created = $this->day('2026-03-10');
        $later = $this->day('2026-03-11');

        $this->assertEquals(['offline_created' => 1, 'messages_visitor' => 1], $created);
        $this->assertSame(1, $later['offline_answered']);
        $this->assertSame(86400 + 3600 + 600, $later['offline_response_sum_s']);
        $this->assertSame(1, $later['offline_closed']);
        $this->assertSame(1, $later['messages_agent']);
        $this->assertArrayNotHasKey('started', $later);
        $this->assertArrayNotHasKey('handled', $later, 'a ticket is not a live chat');
        $this->assertArrayNotHasKey('closed_system', $later);
    }

    public function test_concurrency_counts_overlapping_chats_per_agent_and_overall(): void
    {
        // Ann holds two chats from 12:00:10-12:10:10 and 12:05:10-12:15:10 (they overlap), Bob one from 12:08:00-12:18:00.
        $this->world->chat('2026-03-10 12:00:00')->claimedBy($this->ann, 10)->endedBy('visitor', 600)->save();
        $this->world->chat('2026-03-10 12:05:00')->claimedBy($this->ann, 10)->endedBy('visitor', 600)->save();
        $this->world->chat('2026-03-10 12:07:50')->claimedBy($this->bob, 10)->endedBy('visitor', 600)->save();

        $this->assertSame(3, $this->day('2026-03-10')['peak_concurrent'], '12:08:00-12:10:10: Ann x2 and Bob');
        $this->assertSame(2, $this->day('2026-03-10', 'agent', (string) $this->ann->id)['peak_concurrent']);
        $this->assertSame(1, $this->day('2026-03-10', 'agent', (string) $this->bob->id)['peak_concurrent']);
    }

    public function test_an_interval_that_ends_exactly_when_another_starts_does_not_overlap(): void
    {
        $this->world->chat('2026-03-10 12:00:00')->claimedBy($this->ann, 0)->endedBy('visitor', 600)->save();     // 12:00:00 - 12:10:00
        $this->world->chat('2026-03-10 12:10:00')->claimedBy($this->bob, 0)->endedBy('visitor', 600)->save();     // 12:10:00 - 12:20:00

        $this->assertSame(1, $this->day('2026-03-10')['peak_concurrent']);
    }

    public function test_a_quiet_day_is_a_row_of_zeros_so_rolled_differs_from_not_yet_rolled(): void
    {
        app(RollupDay::class)->handle('2026-03-10', true, 'UTC');

        $row = DB::table('analytics_daily')->where('date', '2026-03-10')->get();

        $this->assertCount(1, $row);
        $this->assertSame('total', $row[0]->dimension);
        $this->assertSame('', $row[0]->dimension_key);
        $this->assertSame(0, (int) $row[0]->started);
        $this->assertSame('UTC', $row[0]->tz);
    }

    public function test_the_day_boundaries_follow_the_time_zone_including_a_dst_day(): void
    {
        // Europe/Berlin changes to summer time on 2026-03-29 at 02:00 local: the day is 23 hours, 2026-03-28T23:00Z to 2026-03-29T22:00Z.
        $this->world->chat('2026-03-28 22:59:59')->save();   // 23:59:59 local on the 28th
        $this->world->chat('2026-03-28 23:00:00')->save();   // 00:00:00 local on the 29th: first second of the short day
        $this->world->chat('2026-03-29 21:59:59')->save();   // 23:59:59 local on the 29th: last second
        $this->world->chat('2026-03-29 22:00:00')->save();   // 00:00:00 local on the 30th

        app(RollupDay::class)->handle('2026-03-29', true, 'Europe/Berlin');
        app(RollupDay::class)->handle('2026-03-28', true, 'Europe/Berlin');
        app(RollupDay::class)->handle('2026-03-30', true, 'Europe/Berlin');

        $this->assertSame(2, $this->storedRows('2026-03-29')['total']['']['started']);
        $this->assertSame(1, $this->storedRows('2026-03-28')['total']['']['started']);
        $this->assertSame(1, $this->storedRows('2026-03-30')['total']['']['started']);
        $this->assertSame('Europe/Berlin', DB::table('analytics_daily')->where('date', '2026-03-29')->value('tz'));
    }
}
