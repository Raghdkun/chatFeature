<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Jobs\SendWhatsAppMessage;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Domain\WhatsApp\Services\SendPacer;
use App\Infrastructure\OpenWa\OpenWaHttpClient;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * C2 + C3: a send that MAY have reached WhatsApp is never repeated (ambiguous answers, our own bookkeeping failing), and the replies of
 * one chat go out in the order they were written even when their jobs wake up in another order.
 */
class WhatsAppSendSafetyTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

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
        settings()->set('whatsapp.send_min_interval_ms', 0);
    }

    private function pending(string $body): WaMessage
    {
        Queue::fake();
        $id = (string) $this->actingAs($this->admin, 'sanctum')
            ->postJson('/api/v1/whatsapp/chats/'.$this->chat->ulid.'/messages', ['body' => $body])
            ->assertCreated()
            ->json('data.ulid');

        return WaMessage::query()->where('ulid', $id)->sole();
    }

    /** The job as a worker runs it: `$release` null = it must not be handed back, a number = exactly that wait, `true` = any number of releases. */
    private function runJob(WaMessage $message, int|bool|null $release = null): void
    {
        $queueJob = Mockery::mock(Job::class);
        $queueJob->shouldReceive('attempts')->andReturn(1);

        if ($release === null) {
            $queueJob->shouldNotReceive('release');
        } elseif ($release === true) {
            $queueJob->shouldReceive('release')->zeroOrMoreTimes();
        } else {
            $queueJob->shouldReceive('release')->once()->with($release);
        }

        $job = new SendWhatsAppMessage($message->id);
        $job->setJob($queueJob);
        $job->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));
    }

    private function useTheRealHttpClient(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);
        settings()->set('whatsapp.openwa.api_key', 'owa_k1_secret-key-for-tests-0123456789');
        settings()->set('whatsapp.openwa.base_url', 'http://127.0.0.1:2785');
        $this->app->forgetInstance(OpenWaClient::class);
        $this->app->bind(OpenWaClient::class, OpenWaHttpClient::class);
    }

    /**
     * @return list<string> the texts that reached OpenWA, in order
     */
    private function sentTexts(): array
    {
        return array_map(fn (array $call): string => (string) $call['args']['text'], $this->openWa()->calls('sendText'));
    }

    // ---- C2: ambiguous answers are never repeated --------------------------------------------------------------------------

    /**
     * @return iterable<string, array{callable(): mixed}>
     */
    public static function ambiguousAnswers(): iterable
    {
        yield 'a 502 from a proxy in front of OpenWA' => [fn () => Http::response('<html>Bad Gateway</html>', 502)];
        yield 'a 504 gateway timeout' => [fn () => Http::response('', 504)];
        yield 'a 500' => [fn () => Http::response(['statusCode' => 500, 'message' => 'Internal server error'], 500)];
        yield 'a 503' => [fn () => Http::response('', 503)];
        yield 'a 201 without a message id' => [fn () => Http::response(['ok' => true], 201)];
        yield 'a 201 with an empty message id' => [fn () => Http::response(['messageId' => '', 'timestamp' => 1], 201)];
        yield 'a 200 that is not JSON' => [fn () => Http::response('<html>welcome</html>', 200)];
        yield 'a 201 with a JSON list' => [fn () => Http::response([['messageId' => 'x']], 201)];
    }

    #[DataProvider('ambiguousAnswers')]
    public function test_an_answer_that_leaves_it_open_whether_the_message_went_out_is_never_sent_again(callable $answer): void
    {
        $this->useTheRealHttpClient();
        $message = $this->pending('Your order has shipped');
        Http::fake(['*' => $answer()]);

        // The job ends normally and is not released: nothing comes back to send it a second time.
        $this->runJob($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Pending, $message->status, 'it may have been delivered: it is not failed either');
        $this->assertNull($message->wa_message_id);
        Http::assertSentCount(1);
        Http::assertSent(fn (Request $request): bool => str_ends_with($request->url(), '/messages/send-text'));
        $this->assertSame(1, app(SendCounter::class)->used($this->session), 'its slot of the daily cap stays taken until it is settled');
    }

    public function test_the_reconciliation_fails_such_a_message_after_thirty_minutes_and_gives_its_slot_back(): void
    {
        $this->useTheRealHttpClient();
        $message = $this->pending('Your order has shipped');
        Http::fake(['*' => Http::response('', 502)]);
        $this->runJob($message);

        $this->travel(31)->minutes();
        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful();

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertStringContainsString('may or may not have been delivered', (string) $message->error);
        $this->assertSame(0, app(SendCounter::class)->used($this->session));
    }

    public function test_only_what_certainly_did_not_reach_whatsapp_is_retried(): void
    {
        $this->useTheRealHttpClient();
        $message = $this->pending('Hello');

        // 409 (not connected) and the plain throttler 429 are retried ...
        Http::fake(['*' => Http::response(['statusCode' => 409, 'message' => 'Session is not connected. The WhatsApp client is not ready.'], 409)]);
        $this->runJob($message, release: 10);
        Http::fake(['*' => Http::response(['statusCode' => 429, 'message' => 'ThrottlerException: Too Many Requests'], 429)]);
        $this->runJob($message, release: true);

        // ... and so is a connection that never got through.
        Http::fake(['*' => Http::failedConnection('cURL error 7: Failed to connect')]);
        $this->runJob($message, release: true);

        $this->assertSame(WaMessageStatus::Pending, $message->refresh()->status);
    }

    /** The `sync` queue: a job without a queue job behind it cannot be released. */
    private function runOnTheSyncQueue(WaMessage $message): void
    {
        (new SendWhatsAppMessage($message->id))->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));
    }

    public function test_on_the_sync_queue_a_transient_refusal_is_asked_again_instead_of_failing_the_reply(): void
    {
        $this->useTheRealHttpClient();
        $message = $this->pending('Hello');
        Http::fake(['*' => Http::sequence()
            ->push(['statusCode' => 429, 'message' => 'ThrottlerException: Too Many Requests'], 429)
            ->push(['statusCode' => 409, 'message' => 'Session is not connected. The WhatsApp client is not ready.'], 409)
            ->push(['messageId' => 'true_4915123456789@c.us_OK', 'timestamp' => 1], 201)]);

        $this->runOnTheSyncQueue($message);

        $this->assertSame(WaMessageStatus::Sent, $message->refresh()->status);
        Http::assertSentCount(3);
    }

    public function test_on_the_sync_queue_a_refusal_that_does_not_clear_fails_with_a_reason_without_the_exception_class(): void
    {
        $this->useTheRealHttpClient();
        $message = $this->pending('Hello');
        Http::fake(['*' => Http::response(['statusCode' => 429, 'message' => 'ThrottlerException: Too Many Requests'], 429)]);

        $this->runOnTheSyncQueue($message);

        $message->refresh();
        $this->assertSame(WaMessageStatus::Failed, $message->status);
        $this->assertStringNotContainsString('ThrottlerException', (string) $message->error);
        $this->assertStringContainsString('too many requests', strtolower((string) $message->error));
        Http::assertSentCount(3);
    }

    public function test_on_the_sync_queue_a_refusal_that_will_not_change_is_not_asked_again(): void
    {
        $this->useTheRealHttpClient();
        $message = $this->pending('Hello');
        Http::fake(['*' => Http::response(['statusCode' => 400, 'message' => 'text must be shorter than or equal to 4096 characters'], 400)]);

        $this->runOnTheSyncQueue($message);

        $this->assertSame(WaMessageStatus::Failed, $message->refresh()->status);
        Http::assertSentCount(1);
    }

    public function test_a_failure_of_our_own_bookkeeping_after_openwa_accepted_the_message_never_sends_it_again(): void
    {
        $message = $this->pending('Hello');
        $thrown = false;
        DB::beforeExecuting(function (string $sql) use (&$thrown): void {
            if (! $thrown && str_starts_with($sql, 'update') && str_contains($sql, 'wa_messages') && str_contains($sql, 'wa_message_id')) {
                $thrown = true;

                throw new \RuntimeException('database went away');
            }
        });

        // The job must not throw (a thrown job is retried by the queue and would send the message twice) and must not be released.
        $this->runJob($message);

        $this->assertTrue($thrown);
        $this->assertSame(['Hello'], $this->sentTexts());
        $this->assertSame(WaMessageStatus::Pending, $message->refresh()->status);
    }

    public function test_a_message_that_may_have_gone_out_does_not_hold_back_the_ones_written_after_it(): void
    {
        $this->useTheRealHttpClient();
        $first = $this->pending('one');
        $second = $this->pending('two');

        Http::fake(['*' => Http::sequence()->push('', 502)->push(['messageId' => 'true_4915123456789@c.us_OK', 'timestamp' => 1], 201)]);
        $this->runJob($first);
        $this->runJob($second);

        $this->assertSame(WaMessageStatus::Pending, $first->refresh()->status);
        $this->assertSame(WaMessageStatus::Sent, $second->refresh()->status);
    }

    // ---- C3: replies go out in the order they were written --------------------------------------------------------------------

    public function test_three_replies_written_within_the_interval_reach_openwa_in_order_whatever_order_their_jobs_wake_up_in(): void
    {
        settings()->set('whatsapp.send_min_interval_ms', 1500);
        $one = $this->pending('one');
        $two = $this->pending('two');
        $three = $this->pending('three');

        // The worst case: the newest job always runs first, the oldest last, round after round while the interval passes.
        foreach (range(1, 8) as $round) {
            foreach ([$three, $two, $one] as $message) {
                if ($message->refresh()->status === WaMessageStatus::Pending) {
                    $this->runJob($message, release: true);
                }
            }

            $this->travel(2)->seconds();
        }

        $this->assertSame(['one', 'two', 'three'], $this->sentTexts());
        $this->assertSame([WaMessageStatus::Sent, WaMessageStatus::Sent, WaMessageStatus::Sent], [$one->refresh()->status, $two->refresh()->status, $three->refresh()->status]);
    }

    public function test_a_younger_reply_waits_two_seconds_while_an_older_one_is_still_pending(): void
    {
        $this->pending('one');
        $two = $this->pending('two');

        $this->runJob($two, release: 2);

        $this->assertSame([], $this->sentTexts());
        $this->assertSame(WaMessageStatus::Pending, $two->refresh()->status);
    }

    public function test_an_older_reply_that_failed_or_was_sent_does_not_hold_back_a_younger_one(): void
    {
        $one = $this->pending('one');
        $two = $this->pending('two');
        $one->forceFill(['status' => WaMessageStatus::Failed, 'error' => 'x'])->save();

        $this->runJob($two);

        $this->assertSame(['two'], $this->sentTexts());
    }

    public function test_replies_of_another_chat_are_independent(): void
    {
        $other = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => '4915999999999@c.us', 'inbound_initiated' => true]);
        $this->pending('one');
        Queue::fake();
        $id = (string) $this->actingAs($this->admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$other->ulid.'/messages', ['body' => 'elsewhere'])->assertCreated()->json('data.ulid');

        $this->runJob(WaMessage::query()->where('ulid', $id)->sole());

        $this->assertSame(['elsewhere'], $this->sentTexts());
    }

    public function test_a_job_that_cannot_be_released_never_waits(): void
    {
        $this->pending('one');
        $two = $this->pending('two');

        // The sync queue / a direct call runs jobs inline, in order: there is nothing to hand back and nobody to wait for.
        (new SendWhatsAppMessage($two->id))->handle(app(OpenWaClient::class), app(SendPacer::class), app(SendCounter::class));

        $this->assertSame(['two'], $this->sentTexts());
    }

    public function test_the_unconfirmed_marker_is_what_frees_the_ones_behind(): void
    {
        $one = $this->pending('one');
        $two = $this->pending('two');

        $this->runJob($two, release: 2);
        Cache::put('wa:unconfirmed:'.$one->id, true, 60);
        $this->runJob($two);

        $this->assertSame(['two'], $this->sentTexts());
    }
}
