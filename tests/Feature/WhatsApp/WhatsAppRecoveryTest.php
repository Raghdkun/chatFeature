<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Actions\ApplySessionState;
use App\Domain\WhatsApp\Actions\SyncWhatsAppSession;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Events\WaChatLinked;
use App\Domain\WhatsApp\Events\WaMessageReceived;
use App\Domain\WhatsApp\Jobs\FetchInboundMedia;
use App\Domain\WhatsApp\Jobs\RunWhatsAppSessionStart;
use App\Domain\WhatsApp\Services\InboundMessageRecorder;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Queue\Connectors\ConnectorInterface;
use Illuminate\Queue\SyncQueue;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Sleep;
use RuntimeException;
use Tests\Support\OpenWaFixtures;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * C1 (a retried inbound delivery finishes what a failed one left half done), C5 (a refused webhook re-registration is retried by the
 * next Start), C7 (an answer of OpenWA that was in flight never overwrites what a webhook said since), C13 (the webhook limiter's keys).
 */
class WhatsAppRecoveryTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    // ---- C1 ----------------------------------------------------------------------------------------------------------------

    /**
     * @return array<string, mixed> the `data` of a `message.received`
     */
    private function messageData(string $text, array $more = []): array
    {
        return $this->messageReceived($more + ['id' => 'false_4915123456789@c.us_RETRY1', 'body' => $text])['data'];
    }

    private function recorder(): InboundMessageRecorder
    {
        return $this->app->make(InboundMessageRecorder::class);
    }

    public function test_a_retry_after_the_linker_failed_links_the_chat_and_announces_the_message_once(): void
    {
        $session = $this->webhookSession();
        $widget = Widget::factory()->create();
        $ticket = WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'code' => 'K7M2QX4P', 'expires_at' => now()->addHour()]);
        $data = $this->messageData('Hi! My support code is K7M2QX4P');
        Event::fake([WaMessageReceived::class, WaChatLinked::class]);

        // The linker's transaction fails once (a deadlock victim, say) AFTER the message row was stored.
        $armed = true;
        DB::beforeExecuting(function (string $sql) use (&$armed): void {
            if ($armed && str_starts_with($sql, 'update') && str_contains($sql, 'wa_handoff_tickets')) {
                $armed = false;

                throw new RuntimeException('deadlock');
            }
        });

        try {
            $this->recorder()->record($session, $data, 'message.received');
            $this->fail('the first attempt should have failed');
        } catch (RuntimeException $exception) {
            $this->assertSame('deadlock', $exception->getMessage());
        }

        $message = WaMessage::query()->sole();
        $this->assertNull($message->announced_at, 'stored, but not finished');
        Event::assertNotDispatched(WaMessageReceived::class);
        $this->assertNull(WaChat::query()->sole()->widget_id);

        // The queue retries the delivery: it must not be taken for a finished duplicate.
        $retry = $this->recorder()->record($session, $data, 'message.received');

        $this->assertSame('processed', $retry->outcome->value);
        $this->assertSame($widget->id, WaChat::query()->sole()->widget_id, 'the chat is linked now');
        $this->assertNotNull($ticket->refresh()->consumed_at);
        $this->assertNotNull($message->refresh()->announced_at);
        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame(1, WaChat::query()->sole()->unread_by_admin, 'counted once');
        Event::assertDispatchedTimes(WaMessageReceived::class, 1);
        Event::assertDispatchedTimes(WaChatLinked::class, 1);

        // And a plain repeat of the finished message stays a no-op.
        $again = $this->recorder()->record($session, $data, 'message.received');

        $this->assertSame('duplicate', $again->outcome->value);
        Event::assertDispatchedTimes(WaMessageReceived::class, 1);
        $this->assertSame(1, WaChat::query()->sole()->unread_by_admin);
    }

    public function test_a_retry_after_the_queue_refused_the_media_job_fetches_the_image(): void
    {
        $session = $this->webhookSession();
        $data = $this->messageData('', ['type' => 'image', 'media' => ['mimetype' => 'image/jpeg', 'omitted' => true, 'sizeBytes' => 2_400_000]]);
        $refusing = new class extends SyncQueue
        {
            public function push($job, $data = '', $queue = null)
            {
                throw new RuntimeException('queue refused');
            }
        };
        $this->app['queue']->extend('refusing', fn () => new class($refusing) implements ConnectorInterface
        {
            public function __construct(private readonly SyncQueue $queue) {}

            public function connect(array $config)
            {
                return $this->queue;
            }
        });
        config(['queue.connections.refusing' => ['driver' => 'refusing'], 'queue.default' => 'refusing']);

        try {
            $this->recorder()->record($session, $data, 'message.received');
            $this->fail('the queue refused, the delivery must fail so that it is retried');
        } catch (RuntimeException $exception) {
            $this->assertSame('queue refused', $exception->getMessage());
        }

        $this->assertNull(WaMessage::query()->sole()->announced_at);

        // The retry: the queue works again.
        config(['queue.default' => 'sync']);
        Queue::fake();
        $this->recorder()->record($session, $data, 'message.received');

        Queue::assertPushed(FetchInboundMedia::class, 1);
        $this->assertNotNull(WaMessage::query()->sole()->announced_at);

        // A repeat of the finished delivery does not queue the fetch a second time.
        $this->recorder()->record($session, $data, 'message.received');
        Queue::assertPushed(FetchInboundMedia::class, 1);
    }

    public function test_the_echo_of_a_reply_the_app_sent_is_not_announced_a_second_time(): void
    {
        $session = $this->webhookSession();
        $chat = WaChat::factory()->for($session, 'session')->create(['chat_id' => '4915123456789@c.us', 'inbound_initiated' => true]);
        $admin = $this->whatsAppPeople()['admin'];
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound($admin)->create(['wa_message_id' => 'true_4915123456789@c.us_ECHO1', 'body' => 'We are on it', 'announced_at' => null]);
        Event::fake([WaMessageReceived::class]);

        // The row of a reply is announced by the reply itself (SendReply sets it); an old row without the mark is completed once, quietly.
        $reply->forceFill(['announced_at' => now()])->save();
        $echo = $this->messageData('We are on it', ['id' => 'true_4915123456789@c.us_ECHO1', 'fromMe' => true, 'from' => '6281234567890@c.us', 'to' => '4915123456789@c.us']);

        $this->assertSame('duplicate', $this->recorder()->record($session, $echo, 'message.sent')->outcome->value);
        $this->assertSame(1, WaMessage::query()->count());
    }

    // ---- C5 ----------------------------------------------------------------------------------------------------------------

    private function admin(): User
    {
        $this->useFortifyMode();

        return $this->whatsAppPeople()['admin'];
    }

    public function test_a_refused_re_registration_leaves_the_session_unregistered_so_start_registers_again(): void
    {
        Sleep::fake();
        Queue::fake();
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000c5', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->withWebhook('an-old-secret-of-forty-characters-00001')->create(['name' => 'support-main', 'openwa_session_id' => $remote->id, 'status' => 'failed']);
        $oldWebhook = $session->openwa_webhook_id;
        $oldSecret = $session->webhook_secret;
        $openWa->willThrow('registerWebhook', new OpenWaRejected('bad_request', 400, 'Destination address is not allowed'));

        $this->actingAs($this->admin(), 'sanctum')->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/webhook')->assertStatus(422)->assertJsonPath('error.code', 'webhook_rejected');

        $session->refresh();
        $openWa->assertCalled('deleteWebhook', fn (array $args): bool => $args['webhookId'] === $oldWebhook, 1);
        $this->assertNull($session->openwa_webhook_id, 'it pointed at the webhook that was just deleted');
        $this->assertNull($session->webhook_registered_at);
        $this->assertFalse($session->isWebhookRegistered());
        $this->assertNotSame($oldSecret, $session->webhook_secret, 'the secret is the new one: the old webhook could not verify any more');

        // The address is fixed (the scripted refusal is used up): Start registers the webhook again instead of skipping it.
        $this->actingAs($this->admin(), 'sanctum')->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202)->assertJsonPath('data.webhookRegistered', true);

        $session->refresh();
        $this->assertNotNull($session->openwa_webhook_id);
        $this->assertTrue($session->isWebhookRegistered());
        $openWa->assertCalled('registerWebhook', null, 2);
    }

    public function test_a_webhook_openwa_no_longer_has_counts_as_deleted_but_one_it_could_not_be_asked_about_is_kept_for_the_next_try(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000c6', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $remote2 = $openWa->makeSession('00000000-0000-4000-8000-0000000000c7', SessionStatus::Created, 'down-hook');
        $openWa->withSession($remote2);

        $gone = WhatsAppSession::factory()->withWebhook()->create(['name' => 'gone-hook', 'openwa_session_id' => $remote->id]);
        $openWa->willThrow('deleteWebhook', new OpenWaRejected('not_found', 404, 'Webhook not found'));
        $openWa->willThrow('registerWebhook', new OpenWaRejected('bad_request', 400, 'x'));
        $this->actingAs($this->admin(), 'sanctum')->postJson('/api/v1/whatsapp/sessions/'.$gone->ulid.'/webhook')->assertStatus(422);
        $this->assertNull($gone->refresh()->openwa_webhook_id);
        $this->assertNull($gone->webhook_registered_at);

        $unreachable = WhatsAppSession::factory()->withWebhook()->create(['name' => 'down-hook', 'openwa_session_id' => $remote2->id]);
        $keptId = $unreachable->openwa_webhook_id;
        $openWa->willThrow('deleteWebhook', new OpenWaUnavailable('OpenWA could not be reached.'));
        $openWa->willThrow('registerWebhook', new OpenWaUnavailable('OpenWA could not be reached.'));
        $this->actingAs($this->admin(), 'sanctum')->postJson('/api/v1/whatsapp/sessions/'.$unreachable->ulid.'/webhook')->assertStatus(503);
        $this->assertSame($keptId, $unreachable->refresh()->openwa_webhook_id, 'still there at OpenWA, the next attempt deletes it');
        $this->assertNull($unreachable->webhook_registered_at);
    }

    // ---- C7 ----------------------------------------------------------------------------------------------------------------

    private function sync(): SyncWhatsAppSession
    {
        return $this->app->make(SyncWhatsAppSession::class);
    }

    public function test_a_reconciliation_answer_in_flight_never_overwrites_a_newer_webhook(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d1', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        // OpenWA builds the answer ("still waiting for a scan"), and before it arrives the `ready` webhook is applied.
        $openWa->will('getSession', function () use ($session, $remote) {
            WhatsAppSession::query()->whereKey($session->id)->update(['status' => SessionStatus::Ready->value]);

            return $remote;
        });

        $this->sync()->reconcile($session);

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status, 'the older answer lost');
        $this->assertNull($session->last_qr);
    }

    public function test_a_reconciliation_between_start_and_the_start_job_does_not_strand_the_session(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d2', SessionStatus::Disconnected, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->failed()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        // The reconciliation reads `failed`, asks OpenWA (which says "stopped"), and meanwhile the administrator pressed Start.
        $openWa->will('getSession', function () use ($session, $remote) {
            WhatsAppSession::query()->whereKey($session->id)->update(['status' => SessionStatus::Starting->value]);

            return $remote;
        });

        $this->sync()->reconcile($session);

        $this->assertSame(SessionStatus::Starting, $session->refresh()->status, 'the start job still finds a session to start');
    }

    public function test_a_session_openwa_does_not_know_is_failed_only_if_nothing_moved_it_meanwhile(): void
    {
        $openWa = $this->openWa();
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main', 'openwa_session_id' => '00000000-0000-4000-8000-0000000000d3']);
        $openWa->will('getSession', function () use ($session) {
            WhatsAppSession::query()->whereKey($session->id)->update(['status' => SessionStatus::Ready->value]);

            throw new OpenWaRejected('not_found', 404, 'Session not found');
        });

        $this->sync()->reconcile($session);

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    public function test_a_qr_fetched_while_a_webhook_said_ready_is_not_stored_and_the_session_stays_ready(): void
    {
        $this->actingAs($this->admin(), 'sanctum');
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d4', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->qr()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id, 'last_qr' => null, 'last_qr_at' => null]);
        $openWa->will('getQr', function () use ($session) {
            WhatsAppSession::query()->whereKey($session->id)->update(['status' => SessionStatus::Ready->value, 'last_qr' => null, 'last_qr_at' => null]);

            return new OpenWaQr(WhatsAppSessionFactory::FAKE_QR, SessionStatus::Qr);
        });

        $this->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertStatus(409)->assertJsonPath('error.code', 'qr_not_available');

        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertNull($session->last_qr, 'a login credential for a session that no longer waits for one is never stored');
    }

    public function test_a_qr_fetched_by_the_reconciliation_while_a_webhook_said_ready_is_not_stored_either(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d5', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->qr()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id, 'last_qr' => null, 'last_qr_at' => null]);
        $openWa->will('getQr', function () use ($session) {
            WhatsAppSession::query()->whereKey($session->id)->update(['status' => SessionStatus::Ready->value]);

            return new OpenWaQr(WhatsAppSessionFactory::FAKE_QR, SessionStatus::Qr);
        });

        $this->sync()->reconcile($session);

        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertNull($session->last_qr);
    }

    public function test_a_qr_fetched_while_nothing_changed_is_stored_as_before(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d6', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->qr()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id, 'last_qr' => null, 'last_qr_at' => null]);

        $this->sync()->reconcile($session);

        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $session->refresh()->last_qr);
        $this->assertSame(SessionStatus::Qr, $session->status);
    }

    public function test_the_session_qr_webhook_still_moves_a_starting_session_to_qr(): void
    {
        $session = $this->webhookSession(state: 'starting');

        $this->deliver($session, $this->envelope('session.qr', ['qr' => OpenWaFixtures::PNG_DATA_URL]))->assertOk();

        $this->assertSame(SessionStatus::Qr, $session->refresh()->status);
        $this->assertNotNull($session->last_qr);
    }

    public function test_the_start_job_never_overwrites_a_newer_webhook_either(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d7', SessionStatus::Starting, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $openWa->will('startSession', function () use ($session, $remote) {
            WhatsAppSession::query()->whereKey($session->id)->update(['status' => SessionStatus::Ready->value]);

            return $remote;
        });

        (new RunWhatsAppSessionStart($session->id))->handle($openWa, $this->app->make(ApplySessionState::class));

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    // ---- C13 ---------------------------------------------------------------------------------------------------------------

    public function test_the_webhook_limiter_gives_every_session_its_own_budget_and_keeps_a_ceiling_per_network(): void
    {
        $one = $this->webhookSession();
        $two = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02');
        config(['whatsapp.webhook.rate_limits.per_session' => 3, 'whatsapp.webhook.rate_limits.per_network' => 5]);

        foreach (range(1, 3) as $index) {
            $this->deliver($one, $this->messageReceived())->assertOk();
        }

        // Session one is used up; OpenWA's other session (same client address) is untouched.
        $this->deliver($one, $this->messageReceived())->assertStatus(429);
        $this->deliver($two, $this->messageReceived())->assertOk();
        $this->deliver($two, $this->messageReceived())->assertOk();

        // The ceiling for everything one network sends: 5 requests in all.
        $this->deliver($two, $this->messageReceived())->assertStatus(429);
    }

    public function test_the_defaults_are_generous_enough_for_one_gateway_hosting_several_sessions(): void
    {
        $this->assertGreaterThanOrEqual(3000, config('whatsapp.webhook.rate_limits.per_session'));
        $this->assertGreaterThanOrEqual(6000, config('whatsapp.webhook.rate_limits.per_network'));
    }
}
