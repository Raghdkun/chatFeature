<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Actions\RecordReceipts;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\MessagesDelivered;
use App\Domain\Chat\Events\MessagesSeen;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Tests\TestCase;

/**
 * Delivery and read receipts: what is stamped, and which events tell the other side (`message.delivered` / `message.seen`).
 */
class RecordReceiptsTest extends TestCase
{
    use RefreshDatabase;

    private User $agent;

    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->agent = User::factory()->agent()->create();
        $this->conversation = Conversation::factory()->active($this->agent)->create();
    }

    /**
     * @return list<Message> four messages: seq 1 and 3 from the agent, 2 and 4 from the visitor
     */
    private function messages(): array
    {
        return [
            Message::factory()->for($this->conversation)->fromAgent($this->agent)->create(),
            Message::factory()->for($this->conversation)->create(),
            Message::factory()->for($this->conversation)->fromAgent($this->agent)->create(),
            Message::factory()->for($this->conversation)->create(),
        ];
    }

    private function record(SenderType $by, ?int $deliveredUpto, ?int $seenUpto): void
    {
        (new RecordReceipts)->handle($this->conversation->fresh(), $by, $deliveredUpto, $seenUpto);
    }

    public function test_delivery_alone_stamps_delivered_and_tells_the_sender(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        [$one, , $three] = $this->messages();

        $this->record(SenderType::Visitor, 3, null);

        $this->assertNotNull($one->fresh()->delivered_at);
        $this->assertNotNull($three->fresh()->delivered_at);
        $this->assertNull($one->fresh()->seen_at);
        Event::assertDispatchedTimes(MessagesDelivered::class, 1);
        Event::assertDispatched(MessagesDelivered::class, fn (MessagesDelivered $event): bool => $event->upToSeq === 3 && $event->by === SenderType::Visitor && $event->conversation->is($this->conversation));
        Event::assertNotDispatched(MessagesSeen::class);
    }

    public function test_the_agents_client_confirms_delivery_of_visitor_messages_the_same_way(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        [, $two, , $four] = $this->messages();

        $this->record(SenderType::Agent, 4, null);

        $this->assertNotNull($two->fresh()->delivered_at);
        $this->assertNotNull($four->fresh()->delivered_at);
        Event::assertDispatched(MessagesDelivered::class, fn (MessagesDelivered $event): bool => $event->upToSeq === 4 && $event->by === SenderType::Agent);
    }

    public function test_repeating_a_delivery_receipt_changes_nothing_and_tells_nobody(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        $this->messages();

        $this->record(SenderType::Visitor, 3, null);
        $this->record(SenderType::Visitor, 3, null);
        $this->record(SenderType::Visitor, 1, null);

        Event::assertDispatchedTimes(MessagesDelivered::class, 1);
    }

    public function test_a_later_delivery_receipt_announces_only_the_new_stretch(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        [$one, , $three] = $this->messages();

        $this->record(SenderType::Visitor, 1, null);
        $firstStamp = $one->fresh()->delivered_at;
        $this->record(SenderType::Visitor, 3, null);

        $this->assertTrue($firstStamp->equalTo($one->fresh()->delivered_at), 'a stamp is never overwritten');
        $this->assertNotNull($three->fresh()->delivered_at);
        Event::assertDispatchedTimes(MessagesDelivered::class, 2);
    }

    public function test_reading_implies_delivery_and_is_announced_by_the_seen_event_alone(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        [$one, , $three] = $this->messages();

        $this->record(SenderType::Visitor, null, 3);

        $this->assertNotNull($one->fresh()->delivered_at);
        $this->assertNotNull($one->fresh()->seen_at);
        $this->assertNotNull($three->fresh()->seen_at);
        Event::assertDispatched(MessagesSeen::class, fn (MessagesSeen $event): bool => $event->upToSeq === 3 && $event->by === SenderType::Visitor);
        Event::assertNotDispatched(MessagesDelivered::class);

        // Delivered and seen to the same number (how the staff client reports an opened chat): still one seen event.
        $this->record(SenderType::Agent, 4, 4);
        Event::assertNotDispatched(MessagesDelivered::class);
        Event::assertDispatchedTimes(MessagesSeen::class, 2);
    }

    public function test_delivered_beyond_what_was_read_sends_both_events(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        [$one, , $three] = $this->messages();

        $this->record(SenderType::Visitor, 3, 1);

        $this->assertNotNull($one->fresh()->seen_at);
        $this->assertNull($three->fresh()->seen_at);
        $this->assertNotNull($three->fresh()->delivered_at);
        Event::assertDispatched(MessagesDelivered::class, fn (MessagesDelivered $event): bool => $event->upToSeq === 3);
        Event::assertDispatched(MessagesSeen::class, fn (MessagesSeen $event): bool => $event->upToSeq === 1);
    }

    public function test_delivery_that_only_covers_what_is_already_stamped_tells_nobody(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        $this->messages();
        $this->record(SenderType::Visitor, null, 3);

        // Messages 1 and 3 are delivered and seen; seq 2 and 4 belong to the visitor, so there is nothing new beyond seq 3.
        $this->record(SenderType::Visitor, 4, null);

        Event::assertNotDispatched(MessagesDelivered::class);
    }

    public function test_numbers_past_the_last_message_are_clamped(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        $this->messages();

        $this->record(SenderType::Visitor, 999, null);

        Event::assertDispatched(MessagesDelivered::class, fn (MessagesDelivered $event): bool => $event->upToSeq === 4);
    }

    public function test_a_receipt_never_touches_the_receivers_own_messages_or_system_lines(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        [, $two] = $this->messages();
        $system = Message::factory()->for($this->conversation)->system()->create();

        $this->record(SenderType::Visitor, 5, null);

        $this->assertNull($two->fresh()->delivered_at, 'the visitor does not confirm delivery of their own message');
        $this->assertNull($system->fresh()->delivered_at);
        Event::assertDispatchedTimes(MessagesDelivered::class, 1);
    }

    public function test_no_event_without_a_receipt_number(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class]);
        $this->messages();

        $this->record(SenderType::Visitor, null, null);
        $this->record(SenderType::Visitor, 0, 0);

        Event::assertNotDispatched(MessagesDelivered::class);
        Event::assertNotDispatched(MessagesSeen::class);
    }
}
