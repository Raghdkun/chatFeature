<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\Actions\RollupDay;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Support\AssertsAnalytics;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * The writer and the reader agree on what the audit events mean: one day of real traffic through the public and staff APIs and the sweeps
 * (not rows written by the test helpers), rolled up and compared with both hand-worked numbers and the independent reference. If a chat
 * action ever changes which events or timestamps it leaves behind, this test is where the analytics notice.
 */
class RollupRealTrafficTest extends TestCase
{
    use AssertsAnalytics, ChatFixtures, RefreshDatabase;

    private const DAY = '2026-03-24';

    private Widget $widget;

    private User $sara;

    private User $colin;

    protected function setUp(): void
    {
        parent::setUp();

        config(['analytics.live_ttl' => 0, 'analytics.report_ttl' => 0, 'analytics.past_report_ttl' => 0]);
        $this->at('08:00:00');
        Mail::fake();
        [$this->widget, $billing] = $this->chatWidget();
        $this->sara = $this->availableAgent($billing, ['name' => 'Sara']);
        $this->colin = $this->availableAgent($billing, ['name' => 'Colin']);
        Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
    }

    /** Move the clock (UTC) and keep both agents online: a heartbeat older than 90 s would make them unavailable. */
    private function at(string $time): void
    {
        $this->travelTo(CarbonImmutable::parse(self::DAY.' '.$time, 'UTC'));

        foreach ([$this->sara ?? null, $this->colin ?? null] as $agent) {
            if ($agent !== null) {
                $this->setPresence($agent, PresenceStatus::Online);
            }
        }
    }

    private function start(string $time, string $message = 'Hello'): array
    {
        $this->at($time);
        $token = $this->visitorSession($this->widget)->plaintext;
        $ulid = $this->withToken($token)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Visitor', 'message' => $message])->assertCreated()->json('data.ulid');

        return [$token, $ulid];
    }

    private function claim(string $time, User $agent, string $ulid): void
    {
        $this->at($time);
        $this->actingAs($agent, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertOk();
    }

    private function say(string $time, User $agent, string $ulid, string $body = 'On it'): void
    {
        $this->at($time);
        $this->actingAs($agent, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/messages", ['client_msg_id' => (string) Str::ulid(), 'body' => $body])->assertCreated();
    }

    /**
     * @return array<string, int>
     */
    private function total(): array
    {
        app(RollupDay::class)->handle(self::DAY, true, 'UTC');

        return $this->storedRows(self::DAY)['total'][''];
    }

    public function test_a_real_day_of_traffic_rolls_up_to_the_numbers_worked_out_by_hand(): void
    {
        // A: accepted after 40 s, answered after 15 s, ended by the agent after 10 minutes, rated 5.
        [$a, $ulidA] = $this->start('09:00:00', 'My invoice is wrong');
        $this->claim('09:00:40', $this->sara, $ulidA);
        $this->say('09:00:55', $this->sara, $ulidA);
        $this->at('09:01:10');
        $this->withToken($a)->postJson("/api/v1/public/conversations/{$ulidA}/messages", ['client_msg_id' => (string) Str::ulid(), 'body' => 'Thanks'])->assertCreated();
        $this->at('09:10:40');
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulidA}/end")->assertOk();
        $this->at('09:12:00');
        $this->withToken($a)->postJson("/api/v1/public/conversations/{$ulidA}/rating", ['score' => 5, 'comment' => 'Great'])->assertCreated();

        // B: nobody accepts: missed by the sweep.
        $this->start('10:00:00');
        $this->at('10:02:00');
        $this->artisan('chat:expire-queued')->assertSuccessful();

        // C: the visitor gives up.
        [$c, $ulidC] = $this->start('11:00:00');
        $this->at('11:00:20');
        $this->withToken($c)->postJson("/api/v1/public/conversations/{$ulidC}/cancel")->assertOk();

        // D: Colin accepts after 20 s, hands it to Sara, who accepts after 30 s; the visitor ends it and skips the rating.
        [$d, $ulidD] = $this->start('12:00:00');
        $this->claim('12:00:20', $this->colin, $ulidD);
        $this->say('12:00:30', $this->colin, $ulidD);
        $this->at('12:05:00');
        $this->actingAs($this->colin, 'sanctum')->postJson("/api/v1/conversations/{$ulidD}/transfer", ['agent_id' => $this->sara->id])->assertOk();
        $this->claim('12:05:30', $this->sara, $ulidD);
        $this->say('12:05:40', $this->sara, $ulidD, 'Colin handed this to me');
        $this->at('12:30:00');
        $this->withToken($d)->postJson("/api/v1/public/conversations/{$ulidD}/end")->assertOk();
        $this->at('12:31:00');
        $this->withToken($d)->postJson("/api/v1/public/conversations/{$ulidD}/rating/skip")->assertOk();

        // E: accepted after 10 s, one answer, then silence: the idle sweep closes it two hours after the last message.
        [, $ulidE] = $this->start('13:00:00');
        $this->claim('13:00:10', $this->sara, $ulidE);
        $this->say('13:00:20', $this->sara, $ulidE);
        $this->at('15:01:00');
        $this->artisan('chat:close-idle')->assertSuccessful();

        // F: an offline ticket, answered 40 minutes after it was left and closed at 17:00.
        $this->at('16:00:00');
        $token = $this->visitorSession($this->widget)->plaintext;
        $ulidF = $this->withToken($token)->postJson('/api/v1/public/offline-tickets', ['name' => 'Ann', 'email' => 'ann@example.test', 'message' => 'Please call me'])->assertCreated()->json('data.ulid');
        $this->claim('16:30:00', $this->colin, $ulidF);
        $this->say('16:40:00', $this->colin, $ulidF, 'Calling you now');
        $this->at('17:00:00');
        $this->actingAs($this->colin, 'sanctum')->postJson("/api/v1/conversations/{$ulidF}/close")->assertOk();

        $this->assertSame(6, Conversation::query()->count());
        $total = $this->total();

        $this->assertSame(5, $total['started']);
        $this->assertSame(3, $total['handled']);
        $this->assertSame(1, $total['reclaimed']);
        $this->assertSame(1, $total['transferred']);
        $this->assertSame(1, $total['missed']);
        $this->assertSame(1, $total['closed_cancelled']);
        $this->assertSame(2, $total['ended']);
        $this->assertSame(1, $total['closed_rated']);
        $this->assertSame(1, $total['closed_skipped']);
        $this->assertSame(1, $total['closed_idle']);
        $this->assertArrayNotHasKey('closed_system', $total, 'closing the ticket is offline_closed, not a live close');
        $this->assertSame(1, $total['res_agent']);
        $this->assertSame(1, $total['res_visitor']);
        $this->assertSame(1, $total['res_idle']);
        $this->assertSame([70, 3, 40], [$total['wait_sum_s'], $total['wait_count'], $total['wait_max_s']]);                  // 40 + 20 + 10
        $this->assertSame([35, 3, 15], [$total['frt_sum_s'], $total['frt_count'], $total['frt_max_s']]);                      // 15 + 10 + 10
        $this->assertSame([600 + 1780 + 7250, 3, 7250], [$total['handling_sum_s'], $total['handling_count'], $total['handling_max_s']]);
        $this->assertSame(1, $total['rating_count']);
        $this->assertSame(1, $total['rating_5']);
        $this->assertSame([1, 1, 1, 2400, 1], [$total['offline_created'], $total['offline_answered'], $total['offline_closed'], $total['offline_response_sum_s'], $total['messages_agent'] - 4]);
        $this->assertSame(1, $total['peak_concurrent']);
        $this->assertGreaterThanOrEqual(1, $total['queue_peak']);
        $this->assertGreaterThanOrEqual(11, $total['offers'], 'both agents offered each of the five chats, plus the direct offer of the transfer');

        // Colin's and Sara's own rows.
        $sara = $this->storedRows(self::DAY)['agent'][(string) $this->sara->id];
        $colin = $this->storedRows(self::DAY)['agent'][(string) $this->colin->id];

        $this->assertSame([2, 1], [$sara['handled'], $sara['reclaimed']]);                          // A and E first; D again
        $this->assertSame(1, $colin['handled']);
        $this->assertSame(1, $colin['transferred']);
        $this->assertSame(3, $sara['ended'] + ($sara['res_idle'] ?? 0), 'Sara finished A and D (ended) and E (idle)');
        $this->assertSame(5, $sara['rating_sum'], 'the rating belongs to the agent who held the chat last');

        // And the independent reference agrees on every cell, the slots included.
        $this->assertRollupMatchesReference(self::DAY, 'UTC');
    }
}
