<?php

namespace Tests\Feature\Notifications;

use App\Domain\Chat\Actions\OfferToAgents;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Domain\Notifications\Services\PushMessages;
use App\Models\Category;
use App\Models\ConversationOffer;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Tests\Support\PushScenario;
use Tests\TestCase;

/**
 * Decision P5-D5, offers: who gets an OS push when a chat request goes out (the real routing runs; the push jobs are recorded).
 */
class PushOfferTest extends TestCase
{
    use PushScenario, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->arrangePushScenario();
    }

    public function test_an_offered_agent_who_is_away_from_the_dashboard_is_pushed_the_request(): void
    {
        $agent = $this->pushableAgent();

        $chat = $this->visitorStartsChat('Hello, I was charged twice');

        $pushes = $this->pushed(PushType::Offer);
        $this->assertCount(1, $pushes);
        $this->assertSame($agent->id, $pushes[0]['user']);

        $message = $pushes[0]['message'];
        $this->assertSame('offer-'.$chat->ulid, $message->tag);
        $this->assertSame('New chat request', $message->title);
        $this->assertSame('Billing - Hello, I was charged twice', $message->body);
        $this->assertSame('/inbox/'.$chat->ulid, $message->url);
        $this->assertSame('high', $message->urgency);
        $this->assertTrue($message->requireInteraction);
        $this->assertFalse($message->renotify);
        // The TTL is what is left of the offer (the widget's queue timeout), never longer.
        $this->assertGreaterThan(0, $message->ttl);
        $this->assertLessThanOrEqual($this->widget->queue_timeout_seconds, $message->ttl);
    }

    public function test_the_payload_carries_no_integer_ids_or_emails(): void
    {
        $this->pushableAgent();
        $chat = $this->visitorStartsChat('Reach me at ann@example.test');

        $payload = $this->pushed(PushType::Offer)[0]['message']->payload();
        $json = (string) json_encode($payload);

        $this->assertSame(['v', 'title', 'body', 'renotify', 'requireInteraction', 'data'], array_keys($payload));
        $this->assertSame(['url', 'tag', 'type'], array_keys($payload['data']));
        $this->assertDoesNotMatchRegularExpression('/"(id|user_id|conversation_id|visitor_id|email)"/', $json);
        $this->assertSame('/inbox/'.$chat->ulid, $payload['data']['url']);
    }

    public function test_every_eligible_offered_agent_gets_their_own_push_and_nobody_else(): void
    {
        $one = $this->pushableAgent();
        $two = $this->pushableAgent();
        $notOffered = User::factory()->agent()->create();
        $this->subscribe($notOffered);
        $otherCategory = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
        $otherCategory->users()->attach($notOffered->id);

        $this->visitorStartsChat();

        $this->assertSame([min($one->id, $two->id), max($one->id, $two->id)], $this->pushedTo(PushType::Offer));
    }

    public function test_an_agent_looking_at_the_dashboard_gets_no_push(): void
    {
        $looking = $this->pushableAgent();
        $away = $this->pushableAgent();
        $this->visibility->lookingAtDashboard($looking->id);

        $this->visitorStartsChat();

        $this->assertSame([$away->id], $this->pushedTo(PushType::Offer));
        // Asked with the configured window (60 s).
        $this->assertContains([$looking->id, 60], $this->visibility->asked);
    }

    public function test_the_window_is_configurable(): void
    {
        config(['push.visible_window_seconds' => 15]);
        $agent = $this->pushableAgent();

        $this->visitorStartsChat();

        $this->assertContains([$agent->id, 15], $this->visibility->asked);
    }

    public function test_an_agent_who_turned_offer_pushes_off_is_skipped(): void
    {
        $off = $this->pushableAgent(['push_offers' => false]);
        $on = $this->pushableAgent(['push_messages' => false]);

        $this->visitorStartsChat();

        $this->assertNotContains($off->id, $this->pushedTo(PushType::Offer));
        $this->assertContains($on->id, $this->pushedTo(PushType::Offer));
    }

    public function test_quiet_hours_silence_the_push_in_the_agents_own_timezone(): void
    {
        // 21:00 UTC is midnight in Riyadh (UTC+3).
        $this->travelTo(CarbonImmutable::parse('2026-11-20 21:00:00', 'UTC'));
        $quiet = $this->pushableAgent(['quiet_hours' => ['enabled' => true, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'Asia/Riyadh']]);
        $awake = $this->pushableAgent(['quiet_hours' => ['enabled' => true, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'UTC']]);
        $disabled = $this->pushableAgent(['quiet_hours' => ['enabled' => false, 'start' => '00:00', 'end' => '23:00', 'timezone' => 'UTC']]);

        $this->visitorStartsChat();

        $recipients = $this->pushedTo(PushType::Offer);
        $this->assertNotContains($quiet->id, $recipients);
        $this->assertContains($awake->id, $recipients);
        $this->assertContains($disabled->id, $recipients);
    }

    public function test_a_user_without_a_registered_browser_is_skipped_before_anything_else_is_asked(): void
    {
        $noDevice = $this->pushableAgent(withDevice: false);

        $this->visitorStartsChat();

        $this->assertSame([], $this->pushed());
        $this->assertNotContains([$noDevice->id, 60], $this->visibility->asked);
    }

    public function test_a_deactivated_staff_member_is_never_pushed(): void
    {
        $agent = $this->pushableAgent();
        $chat = $this->visitorStartsChat();
        Bus::fake([SendPushToUser::class]);

        $agent->forceFill(['is_active' => false])->save();
        ChatOffered::dispatch($chat, ConversationOffer::query()->where('conversation_id', $chat->id)->get(), 1, now()->addSeconds(60));

        $this->assertSame([], $this->pushed());
    }

    public function test_without_vapid_keys_nothing_is_queued(): void
    {
        $this->pushableAgent();
        $this->withoutVapid();

        $this->visitorStartsChat();

        Bus::assertNotDispatched(SendPushToUser::class);
    }

    public function test_privacy_mode_keeps_everything_the_visitor_wrote_out_of_the_push(): void
    {
        $private = $this->pushableAgent(['include_preview' => false]);
        $open = $this->pushableAgent();

        $this->visitorStartsChat('My card number is 4111');

        $byUser = [];

        foreach ($this->pushed(PushType::Offer) as $job) {
            $byUser[$job['user']] = $job['message'];
        }

        $this->assertSame('Billing', $byUser[$private->id]->body);
        $this->assertSame('Billing - My card number is 4111', $byUser[$open->id]->body);
    }

    public function test_the_administrators_switch_turns_previews_off_for_everyone(): void
    {
        settings()->set('notifications.push_include_preview', false);
        $agent = $this->pushableAgent();

        $this->visitorStartsChat('Secret words');

        $this->assertSame('Billing', $this->pushed(PushType::Offer)[0]['message']->body);
        $this->assertSame($agent->id, $this->pushed(PushType::Offer)[0]['user']);
    }

    public function test_the_preview_is_cut_at_120_characters(): void
    {
        $this->pushableAgent();

        $this->visitorStartsChat(str_repeat('word ', 80));

        $body = $this->pushed(PushType::Offer)[0]['message']->body;
        $this->assertLessThanOrEqual(120 + strlen('Billing - '), mb_strlen((string) $body));
        $this->assertStringEndsWith('…', (string) $body);
    }

    public function test_the_push_is_in_the_agents_language_and_names_the_topic_when_there_is_none(): void
    {
        $agent = $this->pushableAgent();
        $agent->forceFill(['locale' => 'en'])->save();
        $chat = $this->visitorStartsChat('Hi');
        $chat->forceFill(['category_id' => null])->save();

        // The same builder, for a chat without a category.
        $message = app(PushMessages::class)->offer($chat->fresh(['category', 'visitor']), $agent, true, now()->addSeconds(30));

        $this->assertSame('General - Hi', $message->body);
    }

    public function test_a_chat_that_is_no_longer_waiting_rings_nobody(): void
    {
        $agent = $this->pushableAgent();
        $chat = $this->visitorStartsChat();
        Bus::fake([SendPushToUser::class]);

        $chat->forceFill(['status' => ConversationStatus::Active, 'assigned_agent_id' => $agent->id])->save();
        $offers = ConversationOffer::query()->where('conversation_id', $chat->id)->get();
        ChatOffered::dispatch($chat, $offers, 1, now()->addSeconds(60));

        Bus::assertNotDispatched(SendPushToUser::class);
    }

    public function test_an_offer_that_was_already_answered_or_expired_is_not_pushed(): void
    {
        $agent = $this->pushableAgent();
        $chat = $this->visitorStartsChat();
        Bus::fake([SendPushToUser::class]);

        ConversationOffer::query()->where('conversation_id', $chat->id)->update(['responded_at' => now(), 'response' => 'taken']);
        $offers = ConversationOffer::query()->where('conversation_id', $chat->id)->get();
        ChatOffered::dispatch($chat, $offers, 1, now()->addSeconds(60));
        Bus::assertNotDispatched(SendPushToUser::class);

        // And an offer whose deadline has passed.
        $chat->forceFill(['status' => ConversationStatus::Queued])->save();
        ConversationOffer::query()->where('conversation_id', $chat->id)->update(['responded_at' => null]);
        ChatOffered::dispatch($chat, ConversationOffer::query()->where('conversation_id', $chat->id)->get(), 1, now()->subSecond());
        Bus::assertNotDispatched(SendPushToUser::class);
        $this->assertNotNull($agent);
    }

    public function test_the_second_wave_pushes_the_agents_it_adds_and_not_the_first_again(): void
    {
        $first = $this->pushableAgent();
        $chat = $this->visitorStartsChat();
        $this->assertSame([$first->id], $this->pushedTo(PushType::Offer));

        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $this->subscribe($away);
        app(OfferToAgents::class)->wave($chat->fresh(), 2);

        $this->assertSame([$away->id], array_slice($this->pushedTo(PushType::Offer), 1));
        $this->assertCount(2, $this->pushed(PushType::Offer));
    }
}
