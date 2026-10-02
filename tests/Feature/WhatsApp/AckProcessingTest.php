<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Domain\WhatsApp\Services\WebhookProcessor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\OpenWaWebhooks;
use Tests\TestCase;

/**
 * `message.ack` / `message.failed`: found by WhatsApp id among the chats of the session, forward-only, late and repeated acks safe, an ack
 * that overtakes its message retried and finally dropped.
 */
class AckProcessingTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase;

    private WhatsAppSession $session;

    private WaChat $chat;

    protected function setUp(): void
    {
        parent::setUp();

        $this->session = $this->webhookSession();
        $this->chat = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => self::CUSTOMER]);
    }

    private function reply(WaMessageStatus $status = WaMessageStatus::Sent, string $id = 'true_4915123456789@c.us_REPLY1'): WaMessage
    {
        return WaMessage::factory()->for($this->chat, 'chat')->outbound()->create(['wa_message_id' => $id, 'status' => $status]);
    }

    public function test_an_ack_moves_the_message_forward_and_announces_it(): void
    {
        $message = $this->reply(WaMessageStatus::Sent);
        Event::fake([WaMessageStatusChanged::class]);

        $this->deliver($this->session, $this->messageAck($message->wa_message_id, 'delivered'))->assertOk();

        $this->assertSame(WaMessageStatus::Delivered, $message->refresh()->status);
        Event::assertDispatched(WaMessageStatusChanged::class, fn (WaMessageStatusChanged $event): bool => $event->from === WaMessageStatus::Sent && $event->message->status === WaMessageStatus::Delivered && $event->message->is($message));
        $this->assertSame(WebhookOutcome::Processed, WaWebhookDelivery::query()->sole()->outcome);
    }

    /**
     * @return iterable<string, array{WaMessageStatus, string, WaMessageStatus}>
     */
    public static function sequences(): iterable
    {
        yield 'pending to sent' => [WaMessageStatus::Pending, 'sent', WaMessageStatus::Sent];
        yield 'pending straight to read' => [WaMessageStatus::Pending, 'read', WaMessageStatus::Read];
        yield 'sent to delivered' => [WaMessageStatus::Sent, 'delivered', WaMessageStatus::Delivered];
        yield 'sent to read' => [WaMessageStatus::Sent, 'read', WaMessageStatus::Read];
        yield 'delivered to read' => [WaMessageStatus::Delivered, 'read', WaMessageStatus::Read];
        yield 'played counts as read' => [WaMessageStatus::Delivered, 'played', WaMessageStatus::Read];
        yield 'sent to failed' => [WaMessageStatus::Sent, 'failed', WaMessageStatus::Failed];
        yield 'a late sent after read changes nothing' => [WaMessageStatus::Read, 'sent', WaMessageStatus::Read];
        yield 'a late delivered after read changes nothing' => [WaMessageStatus::Read, 'delivered', WaMessageStatus::Read];
        yield 'a repeated delivered changes nothing' => [WaMessageStatus::Delivered, 'delivered', WaMessageStatus::Delivered];
        yield 'a delivered message cannot fail' => [WaMessageStatus::Delivered, 'failed', WaMessageStatus::Delivered];
        yield 'a read message cannot fail' => [WaMessageStatus::Read, 'failed', WaMessageStatus::Read];
        yield 'a failed message stays failed' => [WaMessageStatus::Failed, 'delivered', WaMessageStatus::Failed];
    }

    #[DataProvider('sequences')]
    public function test_status_only_ever_advances(WaMessageStatus $from, string $wire, WaMessageStatus $expected): void
    {
        $message = $this->reply($from);

        $this->deliver($this->session, $this->messageAck($message->wa_message_id, $wire))->assertOk();

        $this->assertSame($expected, $message->refresh()->status);
    }

    public function test_a_failure_stores_a_reason_for_administrators(): void
    {
        $message = $this->reply(WaMessageStatus::Sent);

        $this->deliver($this->session, $this->messageAck($message->wa_message_id, 'failed'))->assertOk();

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertSame('WhatsApp reported that the message could not be delivered.', $message->error);
    }

    public function test_the_legacy_integer_ack_is_understood_when_the_status_is_missing(): void
    {
        $message = $this->reply(WaMessageStatus::Sent);
        $body = $this->messageAck($message->wa_message_id, 'delivered');
        unset($body['data']['status']);
        $body['data']['ack'] = 3;

        $this->deliver($this->session, $body)->assertOk();

        $this->assertSame(WaMessageStatus::Read, $message->refresh()->status);
    }

    public function test_an_ack_without_a_usable_status_or_message_id_is_ignored(): void
    {
        $message = $this->reply(WaMessageStatus::Sent);
        $nothing = $this->messageAck($message->wa_message_id, 'delivered');
        unset($nothing['data']['status'], $nothing['data']['ack']);
        $noId = $this->messageAck('x', 'delivered');
        unset($noId['data']['id'], $noId['data']['messageId']);

        $this->deliver($this->session, $nothing)->assertOk();
        $this->deliver($this->session, $noId)->assertOk();

        $this->assertSame(WaMessageStatus::Sent, $message->refresh()->status);
        $this->assertSame([WebhookOutcome::Ignored, WebhookOutcome::Ignored], WaWebhookDelivery::query()->orderBy('id')->pluck('outcome')->all());
    }

    public function test_an_ack_for_another_sessions_message_is_not_applied(): void
    {
        $other = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02');
        $message = $this->reply(WaMessageStatus::Sent);

        $this->deliver($other, $this->messageAck($message->wa_message_id, 'read'))->assertOk();

        $this->assertSame(WaMessageStatus::Sent, $message->refresh()->status);
        $this->assertSame(WebhookOutcome::Ignored, WaWebhookDelivery::query()->sole()->outcome);
    }

    public function test_an_ack_for_a_message_that_was_never_recorded_is_ignored_on_the_sync_queue(): void
    {
        $this->deliver($this->session, $this->messageAck('true_unknown_1', 'delivered'))->assertOk();

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame(WebhookOutcome::Ignored, $delivery->outcome);
        $this->assertSame('The ack belongs to a message that was never recorded.', $delivery->error);
    }

    public function test_an_ack_that_overtakes_its_message_is_retried_later_and_applies_once_the_message_is_there(): void
    {
        $body = $this->messageAck('true_4915123456789@c.us_LATER', 'delivered');
        $raw = (string) json_encode($body);
        $delivery = WaWebhookDelivery::query()->create([
            'session_id' => $this->session->id, 'idempotency_key' => 'ack-key', 'event' => 'message.ack', 'received_at' => now(),
        ]);

        // First attempt: no such message yet -> the job asks to be run again in 5 seconds.
        $first = Mockery::mock(Job::class);
        $first->shouldReceive('attempts')->andReturn(1);
        $first->shouldReceive('release')->once()->with(5);
        $job = new ProcessWebhookDelivery($delivery->id, $raw);
        $job->setJob($first);
        $job->handle(app(WebhookProcessor::class));
        $this->assertNull($delivery->refresh()->outcome);

        // The send job stores the id; the second attempt applies the ack.
        $message = $this->reply(WaMessageStatus::Sent, 'true_4915123456789@c.us_LATER');
        $second = Mockery::mock(Job::class);
        $second->shouldReceive('attempts')->andReturn(2);
        $second->shouldNotReceive('release');
        $retry = new ProcessWebhookDelivery($delivery->id, $raw);
        $retry->setJob($second);
        $retry->handle(app(WebhookProcessor::class));

        $this->assertSame(WaMessageStatus::Delivered, $message->refresh()->status);
        $this->assertSame(WebhookOutcome::Processed, $delivery->refresh()->outcome);
    }

    public function test_an_ack_that_never_finds_its_message_is_dropped_after_the_schedule(): void
    {
        $raw = (string) json_encode($this->messageAck('true_never_1', 'read'));
        $delivery = WaWebhookDelivery::query()->create([
            'session_id' => $this->session->id, 'idempotency_key' => 'ack-key-2', 'event' => 'message.ack', 'received_at' => now(),
        ]);

        $last = Mockery::mock(Job::class);
        $last->shouldReceive('attempts')->andReturn(3);
        $last->shouldNotReceive('release');
        $job = new ProcessWebhookDelivery($delivery->id, $raw);
        $job->setJob($last);
        $job->handle(app(WebhookProcessor::class));

        $this->assertSame(WebhookOutcome::Ignored, $delivery->refresh()->outcome);
    }

    public function test_an_ack_for_an_inbound_message_changes_nothing(): void
    {
        $inbound = WaMessage::factory()->for($this->chat, 'chat')->inbound()->create(['wa_message_id' => 'false_4915123456789@c.us_IN1']);

        $this->deliver($this->session, $this->messageAck('false_4915123456789@c.us_IN1', 'read'))->assertOk();

        $this->assertSame(WaMessageStatus::Received, $inbound->refresh()->status);
    }
}
