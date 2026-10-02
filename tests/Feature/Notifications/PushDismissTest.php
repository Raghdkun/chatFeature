<?php

namespace Tests\Feature\Notifications;

use App\Domain\Chat\Actions\ExpireQueuedConversations;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Models\Conversation;
use App\Models\NotificationSetting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Tests\Support\PushScenario;
use Tests\TestCase;

/**
 * Decision P5-D5, dismissals: when an offer is taken, cancelled or expires, the notification of everybody who was pushed it is closed
 * by a silent push with the same tag (and only theirs: an agent who never got the OS notification is not woken for nothing).
 */
class PushDismissTest extends TestCase
{
    use PushScenario, RefreshDatabase;

    private User $winner;

    private User $loser;

    private User $watching;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        $this->arrangePushScenario();
        $this->winner = $this->pushableAgent();
        $this->loser = $this->pushableAgent();
        $this->watching = $this->pushableAgent();
        $this->visibility->lookingAtDashboard($this->watching->id);
        $this->chat = $this->visitorStartsChat();
        $this->assertCount(2, $this->pushed(PushType::Offer));
        Bus::fake([SendPushToUser::class]);
    }

    private function claim(User $user): void
    {
        $this->actingAs($user, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/claim')->assertOk();
    }

    /**
     * @return list<int>
     */
    private function dismissedFor(): array
    {
        $ids = array_map(fn (array $job): int => $job['user'], array_filter($this->pushed(PushType::Dismiss), fn (array $job): bool => $job['message']->tag === 'offer-'.$this->chat->ulid));
        sort($ids);

        return array_values($ids);
    }

    public function test_when_somebody_wins_the_chat_every_pushed_agent_is_dismissed_including_the_winner(): void
    {
        $this->claim($this->winner);

        $expected = [$this->winner->id, $this->loser->id];
        sort($expected);
        $this->assertSame($expected, $this->dismissedFor());
        $this->assertNotContains($this->watching->id, $this->dismissedFor());
    }

    public function test_the_dismiss_is_silent_with_the_tag_of_the_offer(): void
    {
        $this->claim($this->winner);

        $message = $this->pushed(PushType::Dismiss)[0]['message'];
        $this->assertTrue($message->isSilent());
        $this->assertSame('offer-'.$this->chat->ulid, $message->tag);
        $this->assertNull($message->title);
        $this->assertSame('dismiss', $message->payload()['data']['type']);
        $this->assertArrayNotHasKey('title', $message->payload());
    }

    public function test_it_is_sent_once_per_agent(): void
    {
        $this->claim($this->winner);
        $first = count($this->pushed(PushType::Dismiss));
        $this->claim($this->winner);

        $this->assertSame($first, count($this->pushed(PushType::Dismiss)));
    }

    public function test_the_visitor_cancelling_in_the_queue_dismisses_the_offer(): void
    {
        $this->withToken($this->visitorToken)->postJson('/api/v1/public/conversations/'.$this->chat->ulid.'/cancel')->assertOk();

        $expected = [$this->winner->id, $this->loser->id];
        sort($expected);
        $this->assertSame($expected, $this->dismissedFor());
    }

    public function test_an_expired_queue_dismisses_the_offer(): void
    {
        $this->travel(5)->minutes();

        $this->assertTrue(app(ExpireQueuedConversations::class)->expire($this->chat->id));

        $expected = [$this->winner->id, $this->loser->id];
        sort($expected);
        $this->assertSame($expected, $this->dismissedFor());
    }

    public function test_an_agent_who_declined_push_offers_after_being_pushed_still_gets_the_dismiss(): void
    {
        // The notification may still be on their screen: closing it does not depend on today's preference.
        NotificationSetting::factory()->create(['user_id' => $this->loser->id, 'push_offers' => false]);

        $this->claim($this->winner);

        $this->assertContains($this->loser->id, $this->dismissedFor());
    }

    public function test_nothing_is_dismissed_without_vapid_keys(): void
    {
        $this->withoutVapid();

        $this->claim($this->winner);

        Bus::assertNotDispatched(SendPushToUser::class);
    }

    public function test_the_dismiss_has_a_short_ttl(): void
    {
        $this->claim($this->winner);

        $this->assertLessThanOrEqual(300, $this->pushed(PushType::Dismiss)[0]['message']->ttl);
    }
}
