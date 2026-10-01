<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationAssigned;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Events\ConversationMissed;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationRated;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\OfflineTicketCreated;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Tests\TestCase;

/**
 * The domain events are plain, serialisable carriers of model references that fire only after the transaction committed.
 */
class ChatEventsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return list<object>
     */
    private function everyEvent(): array
    {
        $agent = User::factory()->create();
        $other = User::factory()->create();
        $conversation = Conversation::factory()->active($agent)->create();
        $offers = new Collection([ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $other->id])]);
        $message = Message::factory()->for($conversation)->create();
        $rating = Rating::factory()->create(['conversation_id' => $conversation->id]);

        return [
            new ConversationQueued($conversation),
            new ChatOffered($conversation, $offers, 1, now()->addSeconds(90)),
            new ChatTaken($conversation, $agent, [$other->id]),
            new ConversationClaimed($conversation, $agent),
            new ConversationAssigned($conversation, $agent, $other, $other),
            new ConversationUpdated($conversation),
            new MessageCreated($message),
            new MessagesSeen($conversation, 4, SenderType::Visitor),
            new ConversationEnded($conversation, ConversationEndedBy::Agent),
            new ConversationClosed($conversation, ConversationCloseReason::Rated),
            new ConversationMissed($conversation),
            new ConversationTransferred($conversation, $agent, $other, Category::factory()->create()),
            new OfflineTicketCreated($conversation),
            new ConversationRated($conversation, $rating),
            new UnseenCountChanged($conversation),
            new QueueChanged($conversation),
            new QueueChanged,
            new PresenceChanged($agent->id, PresenceStatus::Online),
            new StaffSessionRevoked($agent->id, SessionRevokeReason::Deactivated),
        ];
    }

    public function test_every_event_waits_for_the_commit(): void
    {
        foreach ($this->everyEvent() as $event) {
            $this->assertInstanceOf(ShouldDispatchAfterCommit::class, $event, $event::class);
        }
    }

    public function test_the_catalogue_is_complete(): void
    {
        $classes = array_map(static fn (object $event): string => class_basename($event), $this->everyEvent());
        $files = array_map(static fn (string $path): string => basename($path, '.php'), glob(app_path('Domain/Chat/Events/*.php')) ?: []);

        $this->assertEqualsCanonicalizing($files, array_values(array_unique($classes)));
        $this->assertCount(18, $files);
    }

    public function test_events_are_dispatchable_statically(): void
    {
        Event::fake([ConversationQueued::class, QueueChanged::class]);
        $conversation = Conversation::factory()->create();

        ConversationQueued::dispatch($conversation);
        QueueChanged::dispatch();

        Event::assertDispatched(ConversationQueued::class, fn (ConversationQueued $event): bool => $event->conversation->is($conversation));
        Event::assertDispatched(QueueChanged::class, fn (QueueChanged $event): bool => $event->conversation === null);
    }

    public function test_events_survive_being_queued(): void
    {
        foreach ($this->everyEvent() as $event) {
            $restored = unserialize(serialize($event));

            $this->assertInstanceOf($event::class, $restored);
        }
    }

    public function test_queued_events_come_back_with_their_models(): void
    {
        $agent = User::factory()->create();
        $conversation = Conversation::factory()->active($agent)->create();

        $restored = unserialize(serialize(new ConversationClaimed($conversation, $agent)));

        $this->assertInstanceOf(ConversationClaimed::class, $restored);
        $this->assertTrue($restored->conversation->is($conversation));
        $this->assertTrue($restored->agent->is($agent));
    }

    public function test_a_listener_only_runs_once_the_surrounding_transaction_committed(): void
    {
        $seen = [];
        Event::listen(ConversationQueued::class, function (ConversationQueued $event) use (&$seen): void {
            $seen[] = $event->conversation->ulid;
        });
        $conversation = Conversation::factory()->create();

        DB::transaction(function () use ($conversation, &$seen): void {
            ConversationQueued::dispatch($conversation);

            $this->assertSame([], $seen, 'not before the commit');
        });

        $this->assertSame([$conversation->ulid], $seen);
    }

    public function test_a_rolled_back_transaction_dispatches_nothing(): void
    {
        $seen = 0;
        Event::listen(ConversationQueued::class, function () use (&$seen): void {
            $seen++;
        });
        $conversation = Conversation::factory()->create();

        try {
            DB::transaction(function () use ($conversation): void {
                ConversationQueued::dispatch($conversation);

                throw new \RuntimeException('roll back');
            });
        } catch (\RuntimeException) {
            // expected
        }

        $this->assertSame(0, $seen);
    }
}
