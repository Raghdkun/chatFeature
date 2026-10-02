<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Actions\SyncWhatsAppSession;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Events\WaMessageSent;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Jobs\ReconcileWhatsAppSession;
use App\Domain\WhatsApp\Jobs\SendWhatsAppMessage;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Domain\WhatsApp\Services\SendPacer;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRequestNotConfirmed;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Contracts\Bus\Dispatcher;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\InteractsWithQueueOutage;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * An administrator's reply: stored `pending`, sent by a queued job under the rules that protect the number (customer wrote first, the
 * session is ready, a minimum interval, a daily cap, OpenWA's own pacing), idempotent by `client_msg_id`, failures with a reason.
 */
class WhatsAppReplyApiTest extends TestCase
{
    use InteractsWithQueueOutage, RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private User $admin;

    private WhatsAppSession $session;

    private WaChat $chat;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = $this->whatsAppPeople()['admin'];
        $this->session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
        $this->chat = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => '4915123456789@c.us', 'inbound_initiated' => true]);
        // No pause between sends unless a test is about the pause (a sync worker would really sleep for it).
        settings()->set('whatsapp.send_min_interval_ms', 0);
    }

    private function reply(string $body = 'We are on it', ?string $clientMsgId = null): TestResponse
    {
        return $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$this->chat->ulid.'/messages', array_filter(['body' => $body, 'client_msg_id' => $clientMsgId]));
    }

    /** Run the queued job by hand, with a queue job whose `release()` is observable. */
    private function runJob(WaMessage $message, ?int $expectRelease = null, int $attempts = 1): void
    {
        $queueJob = Mockery::mock(Job::class);
        $queueJob->shouldReceive('attempts')->andReturn($attempts);

        if ($expectRelease === null) {
            $queueJob->shouldNotReceive('release');
        } else {
            $queueJob->shouldReceive('release')->once()->with($expectRelease);
        }

        $job = new SendWhatsAppMessage($message->id);
        $job->setJob($queueJob);
        $job->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));
    }

    private function pending(string $body = 'Hello'): WaMessage
    {
        Queue::fake();
        $id = (string) $this->reply($body)->assertCreated()->json('data.ulid');

        return WaMessage::query()->where('ulid', $id)->sole();
    }

    // ---- the happy path ----------------------------------------------------------------------------------------------------

    public function test_a_reply_is_stored_pending_queued_and_sent_by_the_job(): void
    {
        Queue::fake();
        Event::fake([WaMessageSent::class, WaMessageStatusChanged::class]);

        $response = $this->reply('We are on it')->assertCreated();

        $response->assertJsonPath('data.direction', 'out')
            ->assertJsonPath('data.type', 'text')
            ->assertJsonPath('data.body', 'We are on it')
            ->assertJsonPath('data.status', 'pending')
            ->assertJsonPath('data.sentBy.id', $this->admin->id)
            ->assertJsonPath('data.chat', $this->chat->ulid);
        $this->assertArrayNotHasKey('waMessageId', $response->json('data'));
        Queue::assertPushed(SendWhatsAppMessage::class, 1);
        $this->openWa()->assertNotCalled('sendText');
        Event::assertDispatched(WaMessageSent::class);

        $message = WaMessage::query()->sole();
        $this->assertNull($message->wa_message_id);
        $this->assertSame($this->admin->id, $message->sent_by_user_id);
        $this->assertSame('We are on it', $this->chat->refresh()->last_message_preview);
        $this->assertSame(1, app(SendCounter::class)->used($this->session));
        $audit = AuditLog::query()->where('action', 'whatsapp.message.sent')->sole();
        $this->assertStringNotContainsString('We are on it', json_encode($audit->changes), 'the text is not in the audit trail');

        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Sent, $message->status);
        $this->assertStringStartsWith('true_4915123456789@c.us_FAKE', (string) $message->wa_message_id);
        $this->openWa()->assertCalled('sendText', fn (array $args): bool => $args['sessionId'] === $this->session->openwa_session_id && $args['chatId'] === '4915123456789@c.us' && $args['text'] === 'We are on it', 1);
        Event::assertDispatched(WaMessageStatusChanged::class, fn (WaMessageStatusChanged $event): bool => $event->from === WaMessageStatus::Pending && $event->message->status === WaMessageStatus::Sent);
    }

    public function test_on_the_sync_queue_the_answer_already_says_sent(): void
    {
        $this->reply('We are on it')->assertCreated()->assertJsonPath('data.status', 'sent');
    }

    public function test_the_text_is_cleaned_like_any_chat_message(): void
    {
        Queue::fake();

        $this->reply("  Hello\r\nthere\x00 \u{202E}x  ")->assertCreated()->assertJsonPath('data.body', "Hello\nthere x");
    }

    /**
     * @return iterable<string, array{mixed}>
     */
    public static function badBodies(): iterable
    {
        yield 'empty' => [''];
        yield 'only spaces' => ['   '];
        yield 'only control characters' => ["\x00\x07"];
        yield 'missing' => [null];
        yield 'an array' => [['x']];
        yield 'too long' => [str_repeat('a', 4097)];
    }

    #[DataProvider('badBodies')]
    public function test_a_bad_body_is_a_422_and_uses_no_slot(mixed $body): void
    {
        $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$this->chat->ulid.'/messages', ['body' => $body])
            ->assertStatus(422)->assertJsonValidationErrors('body', 'error.details');

        $this->assertSame(0, WaMessage::query()->count());
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
        $this->openWa()->assertNotCalled('sendText');
    }

    public function test_exactly_4096_characters_pass(): void
    {
        Queue::fake();

        $this->reply(str_repeat('a', 4096))->assertCreated();
    }

    public function test_a_repeated_client_msg_id_returns_the_original_and_sends_nothing_twice(): void
    {
        $id = (string) Str::ulid();

        $first = $this->reply('We are on it', $id)->assertCreated();
        $second = $this->reply('We are on it', $id)->assertOk();
        $third = $this->reply('A different text, same id', $id)->assertOk();

        $this->assertSame($first->json('data.ulid'), $second->json('data.ulid'));
        $this->assertSame($first->json('data.ulid'), $third->json('data.ulid'));
        $this->assertSame(1, WaMessage::query()->count());
        $this->openWa()->assertCalled('sendText', null, 1);
        $this->assertSame(1, app(SendCounter::class)->used($this->session), 'a repeat takes no slot');
    }

    public function test_the_same_client_msg_id_in_another_chat_is_a_different_message(): void
    {
        $other = WaChat::factory()->for($this->session, 'session')->create(['inbound_initiated' => true]);
        $id = (string) Str::ulid();

        $this->reply('one', $id)->assertCreated();
        $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$other->ulid.'/messages', ['body' => 'two', 'client_msg_id' => $id])->assertCreated();

        $this->assertSame(2, WaMessage::query()->count());
    }

    // ---- rules -------------------------------------------------------------------------------------------------------------

    public function test_a_session_that_is_not_ready_cannot_send(): void
    {
        foreach (['starting', 'qr', 'disconnected', 'failed'] as $state) {
            $session = WhatsAppSession::factory()->{$state}()->create();
            $chat = WaChat::factory()->for($session, 'session')->create(['inbound_initiated' => true]);

            $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => 'hi'])
                ->assertStatus(409)->assertJsonPath('error.code', 'session_not_ready')->assertJsonPath('error.details.status', $state);
        }

        $deleted = WhatsAppSession::factory()->ready()->create();
        $chat = WaChat::factory()->for($deleted, 'session')->create(['inbound_initiated' => true]);
        $deleted->delete();
        $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => 'hi'])->assertStatus(409)->assertJsonPath('error.code', 'session_not_ready');

        $this->assertSame(0, WaMessage::query()->count());
        $this->openWa()->assertNotCalled('sendText');
    }

    public function test_a_customer_who_never_wrote_cannot_be_messaged_unless_the_setting_is_off(): void
    {
        $this->chat->update(['inbound_initiated' => false]);

        $this->reply()->assertStatus(409)->assertJsonPath('error.code', 'reply_not_allowed');
        $this->assertSame(0, WaMessage::query()->count());
        $this->assertSame(0, app(SendCounter::class)->used($this->session));

        settings()->set('whatsapp.reply_only_to_inbound', false);

        $this->reply()->assertCreated();
    }

    public function test_the_daily_cap_is_enforced_per_session_with_a_retry_after_until_midnight_utc(): void
    {
        settings()->set('whatsapp.daily_send_cap', 2);
        $this->travelTo(now()->utc()->setTime(22, 30));

        $this->reply('one')->assertCreated();
        $this->reply('two')->assertCreated();
        $response = $this->reply('three')->assertStatus(429);

        $response->assertJsonPath('error.code', 'daily_cap_reached')->assertJsonPath('error.details.cap', 2);
        $this->assertEqualsWithDelta(90 * 60, (int) $response->headers->get('Retry-After'), 5);
        $this->assertSame((int) $response->headers->get('Retry-After'), $response->json('error.details.retry_after'));
        $this->assertSame(2, WaMessage::query()->count());
        $this->openWa()->assertCalled('sendText', null, 2);

        // Another number has its own allowance.
        $other = WhatsAppSession::factory()->ready()->create();
        $chat = WaChat::factory()->for($other, 'session')->create(['inbound_initiated' => true]);
        $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => 'hi'])->assertCreated();

        // And the allowance starts over at 00:00 UTC.
        $this->travelTo(now()->utc()->addHours(2));
        $this->reply('four')->assertCreated();
    }

    public function test_a_session_can_override_the_global_cap(): void
    {
        settings()->set('whatsapp.daily_send_cap', 100);
        $this->session->forceFill(['settings' => ['daily_send_cap' => 1]])->save();

        $this->reply('one')->assertCreated();
        $this->reply('two')->assertStatus(429)->assertJsonPath('error.details.cap', 1);
    }

    public function test_the_cap_counts_a_message_once_even_when_the_request_repeats(): void
    {
        settings()->set('whatsapp.daily_send_cap', 1);
        $id = (string) Str::ulid();

        $this->reply('one', $id)->assertCreated();
        $this->reply('one', $id)->assertOk();
        $this->reply('two')->assertStatus(429);
    }

    public function test_a_reply_re_opens_an_archived_chat(): void
    {
        $this->chat->update(['status' => 'archived']);
        Queue::fake();

        $this->reply()->assertCreated();

        $this->assertSame('open', $this->chat->refresh()->status->value);
    }

    public function test_a_queue_that_cannot_take_the_job_fails_the_reply_and_gives_the_slot_back(): void
    {
        Bus::shouldReceive('dispatch')->andThrow(new \RuntimeException('redis is down'));

        $this->reply()->assertStatus(503)->assertJsonPath('error.code', 'queue_unavailable');

        $message = WaMessage::query()->sole();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
    }

    public function test_a_queue_failure_is_announced_to_the_open_inbox_as_a_status_change(): void
    {
        Event::fake([WaMessageStatusChanged::class]);
        $this->queueIsDown();

        $this->reply()->assertStatus(503);

        $message = WaMessage::query()->sole();
        Event::assertDispatched(WaMessageStatusChanged::class, fn (WaMessageStatusChanged $event): bool => $event->message->is($message)
            && $event->message->status === WaMessageStatus::Failed
            && $event->from === WaMessageStatus::Pending);
    }

    /** The queue works again after an outage (the facade mock of the outage is dropped). */
    private function queueWorksAgain(): void
    {
        Bus::clearResolvedInstance(Dispatcher::class);
        $this->app->forgetInstance(Dispatcher::class);
        Queue::fake();
    }

    public function test_repeating_the_request_of_a_reply_the_queue_refused_queues_it_again(): void
    {
        $clientMsgId = strtolower((string) Str::ulid());
        $this->queueIsDown();
        $this->reply('We are on it', $clientMsgId)->assertStatus(503)->assertJsonPath('error.code', 'queue_unavailable');
        $message = WaMessage::query()->sole();
        $this->assertSame(0, app(SendCounter::class)->used($this->session));

        $this->queueWorksAgain();
        Event::fake([WaMessageStatusChanged::class]);
        $response = $this->reply('We are on it', $clientMsgId)->assertOk();

        $response->assertJsonPath('data.ulid', $message->ulid)->assertJsonPath('data.status', 'pending');
        $this->assertSame(1, WaMessage::query()->count(), 'the same message, not a twin');
        $message->refresh();
        $this->assertSame(WaMessageStatus::Pending, $message->status);
        $this->assertNull($message->error);
        $this->assertSame(1, app(SendCounter::class)->used($this->session), 'it takes its slot of the daily cap again');
        Queue::assertPushed(SendWhatsAppMessage::class, fn (SendWhatsAppMessage $job): bool => $job->messageId === $message->id);
        Event::assertDispatched(WaMessageStatusChanged::class, fn (WaMessageStatusChanged $event): bool => $event->from === WaMessageStatus::Failed && $event->message->status === WaMessageStatus::Pending);
        $this->assertSame(1, AuditLog::query()->where('action', 'whatsapp.message.requeued')->count());

        // Repeating it once more is the plain idempotent replay: no second queueing, no second slot.
        $this->reply('We are on it', $clientMsgId)->assertOk();
        Queue::assertPushed(SendWhatsAppMessage::class, 1);
        $this->assertSame(1, app(SendCounter::class)->used($this->session));
    }

    public function test_a_second_repeat_only_returns_the_reply_the_first_one_already_queued_again(): void
    {
        $clientMsgId = strtolower((string) Str::ulid());
        $this->queueIsDown();
        $this->reply('We are on it', $clientMsgId)->assertStatus(503);
        $this->queueWorksAgain();

        $this->reply('We are on it', $clientMsgId)->assertOk();
        $this->reply('We are on it', $clientMsgId)->assertOk()->assertJsonPath('data.status', 'pending');

        Queue::assertPushed(SendWhatsAppMessage::class, 1);
        $this->assertSame(1, app(SendCounter::class)->used($this->session));
    }

    public function test_a_failed_reply_that_may_have_reached_whatsapp_is_never_queued_again_by_a_repeat(): void
    {
        $clientMsgId = strtolower((string) Str::ulid());
        Queue::fake();
        $this->reply('We are on it', $clientMsgId)->assertCreated();
        $message = WaMessage::query()->sole();
        $message->forceFill(['status' => WaMessageStatus::Failed, 'error' => 'WhatsApp never confirmed this message. It may or may not have been delivered: check the phone before sending it again.'])->save();

        $this->reply('We are on it', $clientMsgId)->assertOk()->assertJsonPath('data.status', 'failed');

        $this->assertSame(WaMessageStatus::Failed, $message->refresh()->status);
        Queue::assertPushed(SendWhatsAppMessage::class, 1);
    }

    public function test_a_repeat_after_a_queue_failure_still_obeys_the_rules_and_leaves_the_reply_failed(): void
    {
        $clientMsgId = strtolower((string) Str::ulid());
        $this->queueIsDown();
        $this->reply('We are on it', $clientMsgId)->assertStatus(503);
        $message = WaMessage::query()->sole();
        $this->queueWorksAgain();

        // The number went down in the meantime.
        $this->session->forceFill(['status' => SessionStatus::Disconnected])->save();
        $this->reply('We are on it', $clientMsgId)->assertStatus(409)->assertJsonPath('error.code', 'session_not_ready');
        $this->assertSame(WaMessageStatus::Failed, $message->refresh()->status);

        // And the daily cap is full.
        $this->session->forceFill(['status' => SessionStatus::Ready, 'settings' => ['daily_send_cap' => 1, 'send_min_interval_ms' => 0]])->save();
        app(SendCounter::class)->reserve($this->session);
        $this->reply('We are on it', $clientMsgId)->assertStatus(429)->assertJsonPath('error.code', 'daily_cap_reached');
        $this->assertSame(WaMessageStatus::Failed, $message->refresh()->status);
        $this->assertSame(1, app(SendCounter::class)->used($this->session), 'the refused repeat took no slot');
        Queue::assertNothingPushed();
    }

    // ---- the job -----------------------------------------------------------------------------------------------------------

    public function test_a_session_that_went_down_before_the_job_ran_fails_the_message_and_gives_the_slot_back(): void
    {
        $message = $this->pending();
        $this->session->forceFill(['status' => SessionStatus::Disconnected])->save();

        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertSame('The WhatsApp number was not connected when the message was sent.', $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
        $this->openWa()->assertNotCalled('sendText');
    }

    public function test_the_minimum_interval_makes_the_second_send_wait_for_its_slot(): void
    {
        settings()->set('whatsapp.send_min_interval_ms', 4000);
        $first = $this->pending('one');
        $second = $this->pending('two');

        $this->runJob($first);
        $this->assertSame(WaMessageStatus::Sent, $first->refresh()->status);

        // The second arrives early: released until its slot (about 4 s), nothing sent, still pending.
        $queueJob = Mockery::mock(Job::class);
        $queueJob->shouldReceive('attempts')->andReturn(1);
        $queueJob->shouldReceive('release')->once()->withArgs(fn (int $seconds): bool => $seconds >= 3 && $seconds <= 4);
        $job = new SendWhatsAppMessage($second->id);
        $job->setJob($queueJob);
        $job->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));

        $this->assertSame(WaMessageStatus::Pending, $second->refresh()->status);
        $this->openWa()->assertCalled('sendText', null, 1);

        // Once the interval has passed it goes out.
        $this->travel(5)->seconds();
        $this->runJob($second);
        $this->assertSame(WaMessageStatus::Sent, $second->refresh()->status);
    }

    public function test_the_interval_is_per_session_not_global(): void
    {
        settings()->set('whatsapp.send_min_interval_ms', 4000);
        $other = WhatsAppSession::factory()->ready()->create();
        $otherChat = WaChat::factory()->for($other, 'session')->create(['inbound_initiated' => true]);

        $this->assertSame(0, app(SendPacer::class)->acquire($this->session));
        $this->assertGreaterThan(0, app(SendPacer::class)->acquire($this->session));
        $this->assertSame(0, app(SendPacer::class)->acquire($other), 'another number is paced on its own');
        $this->assertNotNull($otherChat);
    }

    public function test_a_session_can_override_the_interval(): void
    {
        settings()->set('whatsapp.send_min_interval_ms', 4000);
        $this->session->forceFill(['settings' => ['send_min_interval_ms' => 0]])->save();

        $this->assertSame(0, app(SendPacer::class)->acquire($this->session->refresh()));
        $this->assertSame(0, app(SendPacer::class)->acquire($this->session));
    }

    public function test_a_short_openwa_pacing_limit_reschedules_the_job_after_it(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaPacingLimited(90, 'cold reachout cap'));

        $this->runJob($message, expectRelease: 91);

        $this->assertSame(WaMessageStatus::Pending, $message->refresh()->status);
        $this->assertSame(1, app(SendCounter::class)->used($this->session), 'still waiting: the slot stays taken');
    }

    public function test_a_long_openwa_pacing_limit_fails_the_message_with_the_wait_and_gives_the_slot_back(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaPacingLimited(34_521, 'Daily allowance of 5 new conversation(s) reached'));

        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertStringContainsString('Daily allowance of 5 new conversation(s) reached', (string) $message->error);
        $this->assertStringContainsString('10 hours', (string) $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
    }

    public function test_the_plain_throttle_is_retried_in_seconds_not_failed(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaRejected('rate_limited', 429, 'ThrottlerException'));

        $queueJob = Mockery::mock(Job::class);
        $queueJob->shouldReceive('attempts')->andReturn(1);
        $queueJob->shouldReceive('release')->once()->withArgs(fn (int $seconds): bool => $seconds >= 5 && $seconds <= 15);
        $job = new SendWhatsAppMessage($message->id);
        $job->setJob($queueJob);
        $job->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));

        $this->assertSame(WaMessageStatus::Pending, $message->refresh()->status);
    }

    /**
     * @return iterable<string, array{OpenWaRejected, string}>
     */
    public static function refusals(): iterable
    {
        yield 'key refused' => [new OpenWaRejected('unauthorized', 401, 'Invalid API key'), 'OpenWA did not accept the API key.'];
        yield 'a validation refusal' => [new OpenWaRejected('bad_request', 400, 'text must be shorter than or equal to 4096 characters'), 'OpenWA refused the request: text must be shorter than or equal to 4096 characters'];
        yield 'unknown session' => [new OpenWaRejected('not_found', 404, "Session 'x' not found"), "OpenWA refused the request: Session 'x' not found"];
    }

    #[DataProvider('refusals')]
    public function test_any_other_refusal_fails_the_message_at_once_with_the_reason(OpenWaRejected $refusal, string $reason): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', $refusal);

        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertSame($reason, $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
    }

    public function test_a_409_not_connected_is_a_state_that_passes_and_is_retried_not_failed(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaRejected('conflict', 409, 'Session is not connected. The WhatsApp client is not ready.'), null);

        $this->runJob($message, expectRelease: 10, attempts: 1);
        $this->runJob($message, expectRelease: 20, attempts: 2);
        $this->runJob($message, expectRelease: 60, attempts: 9);

        $this->assertSame(WaMessageStatus::Pending, $message->refresh()->status);
        $this->assertSame(1, app(SendCounter::class)->used($this->session), 'still waiting: the slot stays taken');
    }

    public function test_a_409_that_never_clears_fails_the_message_with_openwas_reason_when_the_job_cannot_wait_any_more(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaRejected('conflict', 409, 'Session is not connected. The WhatsApp client is not ready.'));

        // Run without a queue job (the sync queue / a direct call cannot release): nothing to wait with.
        $job = new SendWhatsAppMessage($message->id);
        $job->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertSame('OpenWA refused the request: Session is not connected. The WhatsApp client is not ready.', $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
    }

    public function test_a_400_session_not_active_fails_the_message_and_reconciles_the_session(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession($this->session->openwa_session_id, SessionStatus::Disconnected, 'support-main');
        $openWa->withSession($remote);
        $message = $this->pending();
        $openWa->willThrow('sendText', new OpenWaRejected('bad_request', 400, "Session '".$this->session->openwa_session_id."' is not active. Start the session first."));

        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertStringContainsString('no running engine', (string) $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));

        Queue::assertPushed(ReconcileWhatsAppSession::class, fn (ReconcileWhatsAppSession $job): bool => $job->sessionId === $this->session->id);
        (new ReconcileWhatsAppSession($this->session->id))->handle(app(SyncWhatsAppSession::class));
        $openWa->assertCalled('getSession', fn (array $args): bool => $args['sessionId'] === $this->session->openwa_session_id, 1);
        $this->assertSame(SessionStatus::Disconnected, $this->session->refresh()->status, 'the session follows what OpenWA says');
    }

    public function test_an_openwa_that_cannot_be_reached_is_retried_with_backoff_and_then_failed(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaUnavailable('OpenWA could not be reached.'), null);

        $this->runJob($message, expectRelease: 10, attempts: 1);
        $this->runJob($message, expectRelease: 40, attempts: 2);
        $this->assertSame(WaMessageStatus::Pending, $message->refresh()->status);

        // The queue gives up (the deadline passed): the failed hook fails the message.
        $job = new SendWhatsAppMessage($message->id);
        $job->failed(new \RuntimeException('deadline'));

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertSame('WhatsApp could not be reached in time, so the message was not sent.', $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
    }

    public function test_a_send_that_may_have_gone_out_is_never_repeated_and_stays_pending_until_confirmed(): void
    {
        $message = $this->pending();
        $this->openWa()->willThrow('sendText', new OpenWaRequestNotConfirmed('no answer'));

        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Pending, $message->status, 'the customer may have it: not failed, not retried');
        $this->assertNull($message->error);
        $this->openWa()->assertCalled('sendText', null, 1);
        $this->assertSame(1, app(SendCounter::class)->used($this->session));
    }

    public function test_a_job_that_runs_twice_sends_once(): void
    {
        $message = $this->pending();

        $this->runJob($message);
        $this->runJob($message);

        $this->openWa()->assertCalled('sendText', null, 1);
    }

    public function test_when_the_echo_was_stored_as_a_message_of_its_own_the_job_merges_it_into_the_reply(): void
    {
        $message = $this->pending();
        $this->openWa()->will('sendText', new OpenWaSendResult('true_4915123456789@c.us_RACE1', now()->toImmutable()));
        // OpenWA's `message.sent` for this reply was recorded (and already delivered) before the job could store the id.
        WaMessage::factory()->for($this->chat, 'chat')->outbound()->create(['wa_message_id' => 'true_4915123456789@c.us_RACE1', 'status' => WaMessageStatus::Delivered, 'body' => 'Hello', 'sent_by_user_id' => null]);

        $this->runJob($message);

        $this->assertSame(1, WaMessage::query()->count());
        $message->refresh();
        $this->assertSame('true_4915123456789@c.us_RACE1', $message->wa_message_id);
        $this->assertSame(WaMessageStatus::Delivered, $message->status, 'the later status of the echo is kept');
        $this->assertSame($this->admin->id, $message->sent_by_user_id, 'and it is still the administrator\'s reply');
    }
}
