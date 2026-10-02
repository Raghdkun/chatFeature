<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Events\WaChatLinked;
use App\Domain\WhatsApp\Events\WaChatUpdated;
use App\Domain\WhatsApp\Events\WaMessageReceived;
use App\Domain\WhatsApp\Events\WaMessageSent;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Events\WaSessionQrUpdated;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Tests\TestCase;

/**
 * The WhatsApp domain events are plain, serialisable carriers of model references that fire only after the transaction committed.
 */
class WhatsAppEventsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return list<object>
     */
    private function everyEvent(): array
    {
        $chat = WaChat::factory()->linked()->create();
        $message = WaMessage::factory()->outbound()->create(['wa_chat_id' => $chat->id]);
        $ticket = WaHandoffTicket::query()->findOrFail($chat->handoff_ticket_id);
        $session = WhatsAppSession::factory()->qr()->create();

        return [
            new WaMessageReceived($message),
            new WaMessageSent($message),
            new WaMessageStatusChanged($message, WaMessageStatus::Sent),
            new WaChatLinked($chat, $ticket),
            new WaChatUpdated($chat),
            new WaSessionStatusChanged($session, SessionStatus::Starting),
            new WaSessionStatusChanged($session),
            new WaSessionQrUpdated($session),
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
        $files = array_map(static fn (string $path): string => basename($path, '.php'), glob(app_path('Domain/WhatsApp/Events/*.php')) ?: []);

        $this->assertEqualsCanonicalizing($files, array_values(array_unique($classes)));
        $this->assertCount(7, $files);
    }

    public function test_events_carry_what_their_consumers_need(): void
    {
        $chat = WaChat::factory()->linked()->create();
        $message = WaMessage::factory()->create(['wa_chat_id' => $chat->id]);
        $ticket = WaHandoffTicket::query()->findOrFail($chat->handoff_ticket_id);
        $session = WhatsAppSession::factory()->ready()->create();

        $this->assertTrue((new WaMessageReceived($message))->message->chat->is($chat), 'the chat is one relation away');
        $this->assertSame(WaMessageStatus::Pending, (new WaMessageStatusChanged($message, WaMessageStatus::Pending))->from);
        $this->assertTrue((new WaChatLinked($chat, $ticket))->ticket->is($ticket));
        $this->assertNull((new WaSessionStatusChanged($session))->from);
        $this->assertSame(SessionStatus::Qr, (new WaSessionStatusChanged($session, SessionStatus::Qr))->from);
    }

    public function test_events_are_dispatchable_statically(): void
    {
        Event::fake([WaMessageReceived::class, WaSessionQrUpdated::class]);
        $message = WaMessage::factory()->create();
        $session = WhatsAppSession::factory()->qr()->create();

        WaMessageReceived::dispatch($message);
        WaSessionQrUpdated::dispatch($session);

        Event::assertDispatched(WaMessageReceived::class, fn (WaMessageReceived $event): bool => $event->message->is($message));
        Event::assertDispatched(WaSessionQrUpdated::class, fn (WaSessionQrUpdated $event): bool => $event->session->is($session));
    }

    public function test_events_survive_being_queued_and_come_back_with_their_models(): void
    {
        foreach ($this->everyEvent() as $event) {
            $this->assertInstanceOf($event::class, unserialize(serialize($event)));
        }

        $message = WaMessage::factory()->outbound()->create();
        $restored = unserialize(serialize(new WaMessageStatusChanged($message, WaMessageStatus::Sent)));

        $this->assertInstanceOf(WaMessageStatusChanged::class, $restored);
        $this->assertTrue($restored->message->is($message));
        $this->assertSame(WaMessageStatus::Sent, $restored->from);
    }

    public function test_a_listener_only_runs_once_the_surrounding_transaction_committed(): void
    {
        $seen = [];
        Event::listen(WaMessageReceived::class, function (WaMessageReceived $event) use (&$seen): void {
            $seen[] = $event->message->ulid;
        });
        $message = WaMessage::factory()->create();

        DB::transaction(function () use ($message, &$seen): void {
            WaMessageReceived::dispatch($message);

            $this->assertSame([], $seen, 'not before the commit');
        });

        $this->assertSame([$message->ulid], $seen);
    }

    public function test_a_rolled_back_transaction_dispatches_nothing(): void
    {
        $seen = 0;
        Event::listen(WaChatUpdated::class, function () use (&$seen): void {
            $seen++;
        });
        $chat = WaChat::factory()->create();

        try {
            DB::transaction(function () use ($chat): void {
                WaChatUpdated::dispatch($chat);

                throw new \RuntimeException('roll back');
            });
        } catch (\RuntimeException) {
            // expected
        }

        $this->assertSame(0, $seen);
    }
}
