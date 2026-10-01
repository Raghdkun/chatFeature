<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Actions\ExpireQueuedConversations;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationMissed;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Jobs\ExpireQueuedConversation;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use Illuminate\Console\Scheduling\Event as ScheduledEvent;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * The timers: queue timeout, idle close, rating window, housekeeping, and their schedule.
 */
class ChatSweepsTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = $this->availableAgent($this->billing);
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function queued(array $attributes = []): Conversation
    {
        return $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->agent], $attributes);
    }

    public function test_a_chat_nobody_accepted_in_time_becomes_missed(): void
    {
        Event::fake([ConversationMissed::class, ConversationUpdated::class, QueueChanged::class]);
        $due = $this->queued(['queue_expires_at' => now()->subSecond()]);
        $notDue = $this->queued(['queue_expires_at' => now()->addMinute()]);
        $claimed = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id, 'queue_expires_at' => now()->subMinute()]);
        $ticket = Conversation::factory()->offline()->create(['widget_id' => $this->widget->id]);
        $noDeadline = $this->queued(['queue_expires_at' => null]);

        $this->artisan('chat:expire-queued')->expectsOutputToContain('Marked 1 queued chat(s) as missed.')->assertSuccessful();

        $this->assertSame(ConversationStatus::Missed, $due->fresh()->status);
        $this->assertSame(ConversationStatus::Queued, $notDue->fresh()->status);
        $this->assertSame(ConversationStatus::Active, $claimed->fresh()->status);
        $this->assertSame(ConversationStatus::Queued, $ticket->fresh()->status);
        $this->assertSame(ConversationStatus::Queued, $noDeadline->fresh()->status);

        $offer = ConversationOffer::query()->where('conversation_id', $due->id)->sole();
        $this->assertSame(OfferResponse::Expired, $offer->response);
        $this->assertNull(ConversationOffer::query()->where('conversation_id', $notDue->id)->value('response'));
        $this->assertSame('missed', $due->events()->sole()->type);
        Event::assertDispatched(ConversationMissed::class, fn (ConversationMissed $event): bool => $event->conversation->is($due));
        Event::assertDispatched(ConversationUpdated::class, fn (ConversationUpdated $event): bool => $event->conversation->is($due));
        Event::assertDispatched(QueueChanged::class, fn (QueueChanged $event): bool => $event->conversation?->is($due) === true);

        // Running it again is a no-op.
        $this->artisan('chat:expire-queued')->expectsOutputToContain('Marked 0 queued chat(s) as missed.')->assertSuccessful();
    }

    public function test_the_delayed_job_expires_one_chat_only_after_its_deadline(): void
    {
        $chat = $this->queued(['queue_expires_at' => now()->addSeconds(90)]);

        // A sync queue runs delayed jobs at once: before the deadline it must do nothing.
        (new ExpireQueuedConversation($chat->id))->handle(app(ExpireQueuedConversations::class));
        $this->assertSame(ConversationStatus::Queued, $chat->fresh()->status);

        $this->travel(91)->seconds();
        (new ExpireQueuedConversation($chat->id))->handle(app(ExpireQueuedConversations::class));
        $this->assertSame(ConversationStatus::Missed, $chat->fresh()->status);

        // And it never takes a chat that was claimed in the meantime.
        $claimed = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id, 'queue_expires_at' => now()->subMinute()]);
        $this->assertFalse(app(ExpireQueuedConversations::class)->expire($claimed->id));
        $this->assertSame(ConversationStatus::Active, $claimed->fresh()->status);
    }

    public function test_an_active_chat_without_messages_for_the_idle_timeout_is_closed_without_a_rating_prompt(): void
    {
        Event::fake([ConversationClosed::class]);
        $idle = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id, 'idle_expires_at' => now()->subSecond()]);
        $fresh = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id, 'idle_expires_at' => now()->addMinute()]);
        $ticket = Conversation::factory()->offline()->active($this->agent)->create(['widget_id' => $this->widget->id, 'idle_expires_at' => null]);
        $ended = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id, 'idle_expires_at' => now()->subHour()]);
        $queued = $this->queued();

        $this->artisan('chat:close-idle')->expectsOutputToContain('Closed 1 idle chat(s).')->assertSuccessful();

        $idle->refresh();
        $this->assertSame(ConversationStatus::Closed, $idle->status);
        $this->assertSame(ConversationCloseReason::Idle, $idle->close_reason);
        $this->assertNotNull($idle->closed_at);
        $this->assertFalse($idle->rating_requested);
        $this->assertSame('closed', $idle->events()->sole()->type);
        $this->assertSame('idle', $idle->events()->sole()->payload['reason']);
        $this->assertSame(ConversationStatus::Active, $fresh->fresh()->status);
        $this->assertSame(ConversationStatus::Active, $ticket->fresh()->status);
        $this->assertSame(ConversationStatus::Ended, $ended->fresh()->status);
        $this->assertSame(ConversationStatus::Queued, $queued->fresh()->status);
        Event::assertDispatchedTimes(ConversationClosed::class, 1);
        Event::assertDispatched(ConversationClosed::class, fn (ConversationClosed $event): bool => $event->reason === ConversationCloseReason::Idle && $event->conversation->is($idle));
    }

    public function test_messages_keep_a_chat_alive_through_the_idle_sweep(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $this->agent);

        $this->travel(100)->minutes();
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/messages", ['body' => 'still here'])->assertCreated();
        $this->travel(100)->minutes();
        $this->artisan('chat:close-idle')->assertSuccessful();
        $this->assertSame(ConversationStatus::Active, $chat->fresh()->status);

        $this->travel(21)->minutes();
        $this->artisan('chat:close-idle')->expectsOutputToContain('Closed 1 idle chat(s).')->assertSuccessful();
        $this->assertSame(ConversationCloseReason::Idle, $chat->fresh()->close_reason);
    }

    public function test_an_ended_chat_nobody_rated_closes_when_the_window_is_over(): void
    {
        Event::fake([ConversationClosed::class]);
        $overdue = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id, 'rating_window_expires_at' => now()->subSecond()]);
        $waiting = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id, 'rating_window_expires_at' => now()->addMinutes(5)]);
        $active = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id]);

        $this->artisan('chat:close-unrated')->expectsOutputToContain('Closed 1 unrated chat(s).')->assertSuccessful();

        $overdue->refresh();
        $this->assertSame(ConversationStatus::Closed, $overdue->status);
        $this->assertSame(ConversationCloseReason::Timeout, $overdue->close_reason);
        $this->assertFalse($overdue->rating_requested);
        $this->assertSame(ConversationStatus::Ended, $waiting->fresh()->status);
        $this->assertSame(ConversationStatus::Active, $active->fresh()->status);
        Event::assertDispatched(ConversationClosed::class, fn (ConversationClosed $event): bool => $event->reason === ConversationCloseReason::Timeout);

        $this->travel(6)->minutes();
        $this->artisan('chat:close-unrated')->expectsOutputToContain('Closed 1 unrated chat(s).')->assertSuccessful();
    }

    public function test_housekeeping_removes_old_sessions_orphan_visitors_and_unused_uploads(): void
    {
        $keepVisitor = Visitor::factory()->create(['widget_id' => $this->widget->id]);
        $recent = VisitorSession::factory()->create(['visitor_id' => $keepVisitor->id, 'expires_at' => now()->subDays(3)]);
        $live = VisitorSession::factory()->create(['visitor_id' => $keepVisitor->id]);
        $expired = VisitorSession::factory()->create(['visitor_id' => $keepVisitor->id, 'expires_at' => now()->subDays(8)]);
        $revoked = VisitorSession::factory()->create(['visitor_id' => $keepVisitor->id, 'revoked_at' => now()->subDays(8)]);
        $held = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id, 'visitor_id' => $keepVisitor->id, 'visitor_session_id' => $expired->id]);

        $orphan = Visitor::factory()->create(['widget_id' => $this->widget->id, 'created_at' => now()->subDays(9)]);
        $newOrphan = Visitor::factory()->create(['widget_id' => $this->widget->id]);
        $verifiedOrphan = Visitor::factory()->verified()->create(['widget_id' => $this->widget->id, 'created_at' => now()->subDays(9)]);
        $withChat = Visitor::factory()->create(['widget_id' => $this->widget->id, 'created_at' => now()->subDays(9)]);
        Conversation::factory()->closed($this->agent)->create(['widget_id' => $this->widget->id, 'visitor_id' => $withChat->id, 'visitor_session_id' => null]);

        $disk = Storage::disk('local');
        foreach (['old', 'young', 'sent'] as $name) {
            $disk->put("chat/{$name}.png", 'x');
            $disk->put("chat/{$name}_t.png", 'x');
        }
        $chat = Conversation::factory()->active($this->agent)->create(['widget_id' => $this->widget->id]);
        $message = Message::factory()->for($chat)->create();
        $make = fn (string $name, ?int $messageId, string $age) => Attachment::factory()->create([
            'conversation_id' => $chat->id, 'message_id' => $messageId, 'disk' => 'local', 'path' => "chat/{$name}.png", 'thumb_path' => "chat/{$name}_t.png", 'created_at' => $age,
        ]);
        $old = $make('old', null, now()->subHours(25)->toDateTimeString());
        $young = $make('young', null, now()->subHours(2)->toDateTimeString());
        $sent = $make('sent', $message->id, now()->subDays(30)->toDateTimeString());

        $this->artisan('chat:prune-visitor-sessions')->expectsOutputToContain('Deleted 2 session(s), 1 visitor(s) and 1 attachment(s).')->assertSuccessful();

        $this->assertNotNull($recent->fresh());
        $this->assertNotNull($live->fresh());
        $this->assertNull($expired->fresh());
        $this->assertNull($revoked->fresh());
        // The chat outlives its session.
        $this->assertSame(ConversationStatus::Active, $held->fresh()->status);
        $this->assertNull($held->fresh()->visitor_session_id);

        $this->assertNull($orphan->fresh());
        $this->assertNotNull($newOrphan->fresh());
        $this->assertNotNull($verifiedOrphan->fresh());
        $this->assertNotNull($withChat->fresh());
        $this->assertNotNull($keepVisitor->fresh());

        $this->assertNull($old->fresh());
        $this->assertNotNull($young->fresh());
        $this->assertNotNull($sent->fresh());
        $disk->assertMissing(['chat/old.png', 'chat/old_t.png']);
        $disk->assertExists(['chat/young.png', 'chat/young_t.png', 'chat/sent.png', 'chat/sent_t.png']);

        $this->artisan('chat:prune-visitor-sessions --session-days=0 --attachment-hours=0')->assertSuccessful();
        $this->assertNull($young->fresh());
        $this->assertNull($recent->fresh());
    }

    public function test_the_timers_are_scheduled(): void
    {
        $events = collect(app(Schedule::class)->events());
        $find = fn (string $command): ScheduledEvent => $events->first(fn (ScheduledEvent $event): bool => str_contains((string) $event->command, $command)) ?? $this->fail("{$command} is not scheduled");

        foreach (['chat:expire-queued', 'chat:close-idle', 'chat:close-unrated'] as $command) {
            $event = $find($command);
            $this->assertSame('* * * * *', $event->expression, $command);
            $this->assertTrue($event->withoutOverlapping, $command);
            $this->assertTrue($event->onOneServer, $command);
        }

        $prune = $find('chat:prune-visitor-sessions');
        $this->assertSame('45 3 * * *', $prune->expression);
        $this->assertTrue($prune->withoutOverlapping);
        $this->assertTrue($prune->onOneServer);
    }
}
