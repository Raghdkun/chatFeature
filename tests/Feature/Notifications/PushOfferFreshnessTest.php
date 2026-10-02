<?php

namespace Tests\Feature\Notifications;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Notifications\Actions\PushOfferToAgents;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushLedger;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Http;
use Mockery\MockInterface;
use Tests\Support\PushScenario;
use Tests\TestCase;

/**
 * C8: an `offer` push is queued first and runs later, so the job asks again whether the offer is still open: a chat taken (or cancelled,
 * or expired) before the job ran is never rung for, one that closes while the push is on its way is dismissed at once, and the "who was
 * pushed" marker exists before the job is queued so a dismiss that follows immediately finds it.
 */
class PushOfferFreshnessTest extends TestCase
{
    use PushScenario, RefreshDatabase;

    private User $winner;

    private User $loser;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        $this->arrangePushScenario();
        $this->winner = $this->pushableAgent();
        $this->loser = $this->pushableAgent();
        $this->chat = $this->visitorStartsChat();
    }

    private function offerJobFor(User $user): SendPushToUser
    {
        foreach (Bus::dispatched(SendPushToUser::class) as $job) {
            /** @var SendPushToUser $job */
            if ($job->userId === $user->id && $job->message['type'] === PushType::Offer->value) {
                return $job;
            }
        }

        $this->fail('no offer push was queued for the user');
    }

    private function claim(User $user): void
    {
        $this->actingAs($user, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/claim')->assertOk();
    }

    public function test_an_offer_whose_chat_is_still_waiting_is_pushed(): void
    {
        $this->fakePushService();

        $this->offerJobFor($this->winner)->handle(app(PushDispatcher::class));

        $this->assertCount(1, $this->pushRequests());
    }

    public function test_an_offer_whose_chat_was_taken_before_the_job_ran_is_never_pushed(): void
    {
        $this->fakePushService();
        $this->claim($this->winner);

        // The dismiss was recorded first; the offer job of the other agent (and the winner's own) now runs.
        $this->offerJobFor($this->loser)->handle(app(PushDispatcher::class));
        $this->offerJobFor($this->winner)->handle(app(PushDispatcher::class));

        $this->assertSame([], $this->pushRequests());
    }

    public function test_an_offer_the_visitor_cancelled_or_that_expired_is_never_pushed(): void
    {
        $this->fakePushService();
        $this->chat->forceFill(['status' => ConversationStatus::Missed])->save();

        $this->offerJobFor($this->winner)->handle(app(PushDispatcher::class));

        $this->assertSame([], $this->pushRequests());
    }

    public function test_an_offer_that_was_withdrawn_from_this_agent_is_not_pushed_to_them(): void
    {
        $this->fakePushService();
        ConversationOffer::query()->where('user_id', $this->loser->id)->update(['responded_at' => now()]);

        $this->offerJobFor($this->loser)->handle(app(PushDispatcher::class));
        $this->offerJobFor($this->winner)->handle(app(PushDispatcher::class));

        $this->assertCount(1, $this->pushRequests());
    }

    public function test_an_offer_that_closes_while_the_push_is_on_its_way_is_dismissed_at_once(): void
    {
        $job = $this->offerJobFor($this->winner);
        $before = count($this->pushed(PushType::Dismiss));

        Http::fake(function (Request $request) {
            // The chat is taken while the push request is in flight.
            ConversationOffer::query()->update(['responded_at' => now()]);

            return Http::response('', 201);
        });

        $job->handle(app(PushDispatcher::class));

        $dismisses = array_values(array_filter($this->pushed(PushType::Dismiss), fn (array $push): bool => $push['message']->tag === 'offer-'.$this->chat->ulid));
        $this->assertCount($before + 1, $dismisses);
        $this->assertSame($this->winner->id, $dismisses[count($dismisses) - 1]['user']);
    }

    public function test_the_marker_of_who_was_pushed_exists_when_the_offer_is_queued_and_goes_when_queueing_fails(): void
    {
        $ledger = $this->app->make(PushLedger::class);
        $tag = 'offer-'.$this->chat->ulid;

        // Queued fine: the marker is there for the dismiss (it is used once).
        $this->assertTrue($ledger->pull($tag, $this->winner->id));
        $this->assertTrue($ledger->pull($tag, $this->loser->id));

        // A queue that is down: no job, so no marker either.
        $this->mock(PushDispatcher::class, function (MockInterface $mock): void {
            $mock->shouldReceive('isEnabled')->andReturnTrue();
            $mock->shouldReceive('queue')->andReturn(0);
        });
        $offers = ConversationOffer::query()->where('conversation_id', $this->chat->id)->get();

        $queued = $this->app->make(PushOfferToAgents::class)->handle($this->chat, $offers, now()->addMinute());

        $this->assertSame(0, $queued);
        $this->assertFalse($ledger->pull($tag, $this->winner->id));
        $this->assertFalse($ledger->pull($tag, $this->loser->id));
    }
}
