<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesDelivered;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use Illuminate\Broadcasting\BroadcastException;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Route;
use RuntimeException;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\RecordingBroadcaster;
use Tests\TestCase;

/**
 * Realtime is an add-on to REST: whatever fails in it (Reverb down, the queue down, a payload that cannot be built) is reported and
 * the request that caused the event succeeds with its data stored.
 */
class RealtimeFailureIsolationTest extends TestCase
{
    use InteractsWithRealtime, RefreshDatabase;

    private RecordingBroadcaster $wire;

    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->wire = $this->recordBroadcasts();
        $this->conversation = Conversation::factory()->active(User::factory()->agent()->create())->create();

        // A stand-in for the Chat actions: store the message in a transaction, then announce it.
        Route::post('/_probe/send', function () {
            $message = DB::transaction(fn (): Message => Message::factory()->for($this->conversation)->create(['body' => 'stored']));
            MessageCreated::dispatch($message);
            ConversationUpdated::dispatch($this->conversation);
            QueueChanged::dispatch();

            return response()->json(['ulid' => $message->ulid], 201);
        });
    }

    public function test_a_reverb_that_rejects_every_publish_does_not_fail_the_request_that_stored_the_message(): void
    {
        Exceptions::fake();
        $this->wire->failWith(new BroadcastException('Pusher error: connection refused.'));

        $this->postJson('/_probe/send')->assertCreated();

        $this->assertDatabaseHas('messages', ['body' => 'stored', 'conversation_id' => $this->conversation->id]);
        Exceptions::assertReported(fn (BroadcastException $exception): bool => str_contains($exception->getMessage(), 'connection refused'));
        $this->assertSame([], $this->wire->published);
    }

    public function test_the_same_holds_for_the_other_immediate_events_and_the_typing_fallback(): void
    {
        Exceptions::fake();
        $this->wire->failWith(new BroadcastException('down'));

        // A user without chats: a revoked agent's open chats would be requeued (4A's listener), each with its own broadcasts.
        StaffSessionRevoked::dispatch(999_999, SessionRevokeReason::Deactivated);
        TypingBroadcast::dispatch($this->conversation->ulid, SenderType::Visitor, true);
        MessagesSeen::dispatch($this->conversation, 1, SenderType::Visitor);
        MessagesDelivered::dispatch($this->conversation, 1, SenderType::Visitor);

        Exceptions::assertReportedCount(4);
    }

    public function test_a_queue_that_cannot_be_reached_does_not_fail_the_request_either(): void
    {
        Exceptions::fake();
        $this->app->instance('queue', new class
        {
            public function connection(): object
            {
                return new class
                {
                    public function pushOn(): never
                    {
                        throw new RuntimeException('Connection refused [tcp://127.0.0.1:6379]');
                    }

                    public function push(): never
                    {
                        throw new RuntimeException('Connection refused [tcp://127.0.0.1:6379]');
                    }
                };
            }
        });

        $this->postJson('/_probe/send')->assertCreated();

        $this->assertDatabaseHas('messages', ['body' => 'stored']);
        Exceptions::assertReported(fn (RuntimeException $exception): bool => str_contains($exception->getMessage(), 'Connection refused'));
        $this->assertNotEmpty($this->wire->of('message.created'), 'the immediate event does not need the queue');
    }

    public function test_a_payload_that_cannot_be_built_is_reported_and_other_listeners_still_run(): void
    {
        Exceptions::fake();
        $this->app->instance(AttachmentUrls::class, new class implements AttachmentUrls
        {
            public function url(Attachment $attachment): string
            {
                throw new RuntimeException('Route [public.attachments.show] not defined.');
            }

            public function thumbUrl(Attachment $attachment): ?string
            {
                return null;
            }
        });
        $ranAfter = false;
        app('events')->listen(MessageCreated::class, function () use (&$ranAfter): void {
            $ranAfter = true;
        });
        $message = Message::factory()->for($this->conversation)->image()->create();

        MessageCreated::dispatch($message);

        Exceptions::assertReported(fn (RuntimeException $exception): bool => str_contains($exception->getMessage(), 'public.attachments.show'));
        $this->assertTrue($ranAfter, 'a failure in the realtime listener does not stop the next listener');
        $this->assertSame([], $this->wire->of('message.created'));
    }

    public function test_a_real_reverb_that_is_not_listening_costs_neither_the_request_nor_much_time(): void
    {
        $this->useReverbBroadcaster();
        config([
            'broadcasting.connections.reverb.options.host' => '127.0.0.1',
            'broadcasting.connections.reverb.options.port' => 9,
            'broadcasting.connections.reverb.options.scheme' => 'http',
            'broadcasting.connections.reverb.options.useTLS' => false,
            'broadcasting.connections.reverb.client_options.connect_timeout' => 1,
            'broadcasting.connections.reverb.client_options.timeout' => 2,
        ]);
        app(BroadcastManager::class)->purge('reverb');
        Exceptions::fake();

        $started = microtime(true);
        $this->postJson('/_probe/send')->assertCreated();

        $this->assertLessThan(5.0, microtime(true) - $started);
        Exceptions::assertReported(fn (BroadcastException $exception): bool => str_contains($exception->getMessage(), 'Failed to connect'));
    }

    public function test_the_publish_timeouts_are_short(): void
    {
        $options = config('broadcasting.connections.reverb.client_options');

        $this->assertLessThanOrEqual(5, $options['connect_timeout']);
        $this->assertLessThanOrEqual(10, $options['timeout']);
    }

    public function test_events_still_flow_when_nothing_failed(): void
    {
        $this->postJson('/_probe/send')->assertCreated();

        $this->assertNotEmpty($this->wire->of('message.created'));
        $this->assertNotEmpty($this->wire->of('conversation.updated'));
        $this->assertNotEmpty($this->wire->of('queue.updated'));
    }
}
