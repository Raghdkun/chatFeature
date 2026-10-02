<?php

namespace Tests\Feature\Notifications;

use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Models\Conversation;
use App\Models\NotificationSetting;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Str;
use Tests\Support\PushScenario;
use Tests\TestCase;

/**
 * Decision P5-D5, messages: a visitor's message in a chat assigned to an agent who is not looking pushes that agent (tag `chat-{ulid}`),
 * and reading, ending or handing over the chat closes the notification again.
 */
class PushMessageTest extends TestCase
{
    use PushScenario, RefreshDatabase;

    private User $agent;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        $this->arrangePushScenario();
        $this->agent = $this->pushableAgent();
        $this->chat = $this->visitorStartsChat('First words');
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/claim')->assertOk();
        Bus::fake([SendPushToUser::class]);
    }

    private function visitorSays(string $text): void
    {
        $this->withToken($this->visitorToken)
            ->postJson('/api/v1/public/conversations/'.$this->chat->ulid.'/messages', ['body' => $text, 'client_msg_id' => (string) Str::ulid()])
            ->assertSuccessful();
    }

    public function test_a_visitor_message_pushes_the_assigned_agent(): void
    {
        $this->visitorSays('Are you there?');

        $pushes = $this->pushed(PushType::Message);
        $this->assertCount(1, $pushes);
        $this->assertSame($this->agent->id, $pushes[0]['user']);

        $message = $pushes[0]['message'];
        $this->assertSame('chat-'.$this->chat->ulid, $message->tag);
        $this->assertSame('New message from Ann', $message->title);
        $this->assertSame('Are you there?', $message->body);
        $this->assertSame('/inbox/'.$this->chat->ulid, $message->url);
        $this->assertTrue($message->renotify);
        $this->assertFalse($message->requireInteraction);
        $this->assertSame('normal', $message->urgency);
    }

    public function test_an_agent_looking_at_the_dashboard_is_not_pushed(): void
    {
        $this->visibility->lookingAtDashboard($this->agent->id);

        $this->visitorSays('Hello?');

        $this->assertSame([], $this->pushed());
    }

    public function test_the_message_preference_and_quiet_hours_are_honoured(): void
    {
        NotificationSetting::factory()->create(['user_id' => $this->agent->id, 'push_messages' => false]);
        $this->visitorSays('one');
        $this->assertSame([], $this->pushed());

        NotificationSetting::query()->where('user_id', $this->agent->id)->update(['push_messages' => true, 'quiet_hours' => json_encode(['enabled' => true, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'UTC'])]);
        $this->travelTo(CarbonImmutable::now('UTC')->setTime(23, 0));
        $this->visitorSays('two');
        $this->assertSame([], $this->pushed());

        $this->travelTo(CarbonImmutable::now('UTC')->setTime(12, 0));
        $this->visitorSays('three');
        $this->assertCount(1, $this->pushed(PushType::Message));
    }

    public function test_messages_in_a_row_notify_once_per_throttle_window(): void
    {
        config(['push.message_throttle_seconds' => 8]);

        $this->visitorSays('one');
        $this->visitorSays('two');
        $this->visitorSays('three');
        $this->assertCount(1, $this->pushed(PushType::Message));

        $this->travel(9)->seconds();
        $this->visitorSays('four');
        $this->assertCount(2, $this->pushed(PushType::Message));
        $this->assertSame('four', $this->pushed(PushType::Message)[1]['message']->body);
    }

    public function test_privacy_mode_hides_the_name_and_the_words(): void
    {
        NotificationSetting::factory()->create(['user_id' => $this->agent->id, 'include_preview' => false]);

        $this->visitorSays('My password is hunter2');

        $message = $this->pushed(PushType::Message)[0]['message'];
        $this->assertSame('New message', $message->title);
        $this->assertSame('Open the chat to read it.', $message->body);
        $this->assertStringNotContainsString('hunter2', (string) json_encode($message->payload()));
        $this->assertStringNotContainsString('Ann', (string) json_encode($message->payload()));
    }

    public function test_the_agents_own_messages_and_system_lines_never_push(): void
    {
        $this->actingAs($this->agent, 'sanctum')
            ->postJson('/api/v1/conversations/'.$this->chat->ulid.'/messages', ['body' => 'Hi Ann', 'client_msg_id' => (string) Str::ulid()])
            ->assertSuccessful();

        $this->assertSame([], $this->pushed());
    }

    public function test_a_chat_that_is_not_active_pushes_nobody(): void
    {
        $this->chat->forceFill(['status' => 'ended'])->save();

        $message = $this->chat->messages()->create(['seq' => 99, 'sender_type' => 'visitor', 'type' => 'text', 'body' => 'late']);
        MessageCreated::dispatch($message);

        $this->assertSame([], $this->pushed());
    }

    public function test_an_image_without_text_is_described_not_empty(): void
    {
        $this->chat->messages()->create(['seq' => 98, 'sender_type' => 'visitor', 'type' => 'image', 'body' => null]);
        $image = $this->chat->messages()->where('seq', 98)->firstOrFail();

        MessageCreated::dispatch($image);

        $this->assertSame('Sent an image', $this->pushed(PushType::Message)[0]['message']->body);
    }

    public function test_reading_the_chat_dismisses_the_message_notification_once(): void
    {
        $this->visitorSays('Are you there?');
        Bus::fake([SendPushToUser::class]);

        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/receipts', ['seen_upto' => 1])->assertSuccessful();

        $dismiss = $this->pushed(PushType::Dismiss);
        $this->assertCount(1, $dismiss);
        $this->assertSame($this->agent->id, $dismiss[0]['user']);
        $this->assertSame('chat-'.$this->chat->ulid, $dismiss[0]['message']->tag);

        // Reading again does not push again: the marker was used.
        Bus::fake([SendPushToUser::class]);
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/receipts', ['seen_upto' => 2])->assertSuccessful();
        $this->assertSame([], $this->pushed(PushType::Dismiss));
    }

    public function test_nothing_is_dismissed_when_no_message_notification_was_sent(): void
    {
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/receipts', ['seen_upto' => 1])->assertSuccessful();

        $this->assertSame([], $this->pushed());
    }

    public function test_the_visitor_reading_does_not_dismiss_the_agents_notification(): void
    {
        $this->visitorSays('hello');
        Bus::fake([SendPushToUser::class]);

        $this->withToken($this->visitorToken)->postJson('/api/v1/public/conversations/'.$this->chat->ulid.'/receipts', ['seen_upto' => 1])->assertSuccessful();

        $this->assertSame([], $this->pushed(PushType::Dismiss));
    }

    public function test_ending_the_chat_dismisses_the_message_notification(): void
    {
        $this->visitorSays('hello');
        Bus::fake([SendPushToUser::class]);

        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/end')->assertSuccessful();

        $this->assertSame([$this->agent->id], array_map(fn (array $job): int => $job['user'], $this->pushed(PushType::Dismiss)));
    }

    public function test_transferring_the_chat_dismisses_the_notification_of_the_agent_who_lost_it(): void
    {
        $colleague = $this->availableAgent($this->billing);
        $this->visitorSays('hello');
        Bus::fake([SendPushToUser::class]);

        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$this->chat->ulid.'/transfer', ['agent_id' => $colleague->id])->assertSuccessful();

        $dismiss = array_values(array_filter($this->pushed(PushType::Dismiss), fn (array $job): bool => $job['message']->tag === 'chat-'.$this->chat->ulid));
        $this->assertCount(1, $dismiss);
        $this->assertSame($this->agent->id, $dismiss[0]['user']);
    }
}
