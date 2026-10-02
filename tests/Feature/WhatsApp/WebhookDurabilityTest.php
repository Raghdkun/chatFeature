<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Actions\ReplayWebhookDeliveries;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Domain\WhatsApp\Services\WebhookProcessor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use Carbon\CarbonImmutable;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Mockery;
use Tests\Support\OpenWaWebhooks;
use Tests\TestCase;

/**
 * S3 + C4: the webhook trusts only the SIGNED body (key, event, ordering), and an accepted delivery survives a lost queue job or an
 * exhausted retry budget: its raw body stays on the ledger row until it is processed, `whatsapp:replay-deliveries` queues it again.
 */
class WebhookDurabilityTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase;

    // ---- S3: the unsigned headers decide nothing ---------------------------------------------------------------------------

    public function test_the_dedupe_key_is_the_one_in_the_signed_body_not_the_header(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $raw = $this->rawBody($session, $this->messageReceived(key: 'msg_signed_key_1'));

        $this->deliver($session, $raw, headers: ['X-OpenWA-Idempotency-Key' => 'attacker-key-1'])->assertExactJson(['status' => 'accepted']);
        // The captured delivery replayed with a fresh, attacker-chosen header key is still the same delivery.
        $this->deliver($session, $raw, headers: ['X-OpenWA-Idempotency-Key' => 'attacker-key-2'])->assertExactJson(['status' => 'duplicate']);
        $this->deliver($session, $raw, headers: ['X-OpenWA-Idempotency-Key' => false])->assertExactJson(['status' => 'duplicate']);

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame('msg_signed_key_1', $delivery->idempotency_key);
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);
    }

    public function test_a_body_without_a_key_is_keyed_by_its_content_never_by_a_header(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $body = $this->messageReceived();
        unset($body['idempotencyKey']);
        $raw = $this->rawBody($session, $body);

        $this->deliver($session, $raw, headers: ['X-OpenWA-Idempotency-Key' => 'one'])->assertExactJson(['status' => 'accepted']);
        $this->deliver($session, $raw, headers: ['X-OpenWA-Idempotency-Key' => 'two'])->assertExactJson(['status' => 'duplicate']);

        $this->assertSame('body:'.hash('sha256', $raw), WaWebhookDelivery::query()->sole()->idempotency_key);
    }

    public function test_the_delivery_id_is_the_signed_ones(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $body = $this->messageReceived();
        $body['deliveryId'] = 'dlv_signed';

        $this->deliver($session, $body, headers: ['X-OpenWA-Delivery-Id' => 'dlv_forged'])->assertOk();

        $this->assertSame('dlv_signed', WaWebhookDelivery::query()->sole()->delivery_id);
    }

    public function test_an_older_session_event_replayed_with_a_fresh_key_is_dropped_even_after_the_cache_and_the_ledger_are_gone(): void
    {
        $session = $this->webhookSession(state: 'starting');
        $newer = ['timestamp' => '2026-10-02T02:11:05.000Z'] + $this->envelope('session.status', ['status' => 'ready']);
        $older = ['timestamp' => '2026-10-02T02:11:04.000Z'] + $this->envelope('session.status', ['status' => 'qr_ready']);

        $this->deliver($session, $newer)->assertOk();
        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
        $this->assertSame(CarbonImmutable::parse('2026-10-02T02:11:05.000Z')->getTimestampMs(), $session->last_event_ms, 'the newest applied event is kept in the database');

        // A day later: the one-hour cache of the old design would be empty, the ledger row pruned.
        Cache::flush();
        WaWebhookDelivery::query()->delete();
        $this->travel(2)->days();

        $this->deliver($session, $older)->assertOk();

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status, 'the captured older event changed nothing');
        $this->assertSame('Older than what was already applied to this session.', WaWebhookDelivery::query()->sole()->error);
    }

    public function test_the_ordering_mark_never_moves_backwards_and_is_per_session(): void
    {
        $one = $this->webhookSession(state: 'starting');
        $two = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02', 'starting');

        $this->deliver($one, ['timestamp' => '2026-10-02T02:11:05.000Z'] + $this->envelope('session.status', ['status' => 'ready']))->assertOk();
        $this->deliver($one, ['timestamp' => '2026-10-02T02:11:01.000Z'] + $this->envelope('session.status', ['status' => 'qr_ready']))->assertOk();
        $this->deliver($two, ['timestamp' => '2026-10-02T02:11:02.000Z'] + $this->envelope('session.status', ['status' => 'qr_ready']))->assertOk();

        $this->assertSame(CarbonImmutable::parse('2026-10-02T02:11:05.000Z')->getTimestampMs(), $one->refresh()->last_event_ms);
        $this->assertSame(CarbonImmutable::parse('2026-10-02T02:11:02.000Z')->getTimestampMs(), $two->refresh()->last_event_ms);
        $this->assertSame(SessionStatus::Qr, $two->status);
    }

    // ---- C4: the body stays until the delivery is processed ------------------------------------------------------------------

    public function test_the_raw_body_is_kept_on_the_ledger_row_while_the_delivery_waits_and_cleared_when_it_is_processed(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $raw = $this->rawBody($session, $this->messageReceived(['body' => 'a customer question']));

        $this->deliver($session, $raw)->assertOk();

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame($raw, $delivery->body);
        $this->assertNull($delivery->outcome);

        // The queue runs the job (it reads the body from the row, not from its own payload).
        Queue::assertPushed(ProcessWebhookDelivery::class, fn (ProcessWebhookDelivery $job): bool => $job->deliveryId === $delivery->id && $job->body === null);
        (new ProcessWebhookDelivery($delivery->id))->handle($this->app->make(WebhookProcessor::class));

        $delivery->refresh();
        $this->assertSame(WebhookOutcome::Processed, $delivery->outcome);
        $this->assertNull($delivery->body, 'the customer text does not stay in the ledger');
        $this->assertSame(1, WaMessage::query()->count());
    }

    public function test_a_delivery_whose_job_was_lost_is_queued_again_by_the_replay_and_then_processed(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $this->deliver($session, $this->messageReceived(['body' => 'lost in the queue']))->assertOk();
        $delivery = WaWebhookDelivery::query()->sole();

        // A job that was queued a moment ago is not touched.
        $this->artisan('whatsapp:replay-deliveries')->assertSuccessful();
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);

        // Three minutes on, nothing ever completed it (the queue was flushed): the replay owns it.
        $this->travel(3)->minutes();
        $this->artisan('whatsapp:replay-deliveries')->assertSuccessful();
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);
        $this->assertSame(1, $delivery->refresh()->replays);

        // And it is not queued again while that new job is young.
        $this->artisan('whatsapp:replay-deliveries')->assertSuccessful();
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);

        Queue::assertPushed(ProcessWebhookDelivery::class, function (ProcessWebhookDelivery $job) use ($delivery): bool {
            (new ProcessWebhookDelivery($job->deliveryId))->handle($this->app->make(WebhookProcessor::class));

            return $job->deliveryId === $delivery->id;
        });
        $this->assertSame('lost in the queue', WaMessage::query()->sole()->body);
        $this->assertSame(WebhookOutcome::Processed, $delivery->refresh()->outcome);
    }

    public function test_the_replay_budget_is_bounded_for_a_delivery_that_never_completes(): void
    {
        Queue::fake();
        config(['whatsapp.webhook.replay.max' => 2]);
        $this->deliver($this->webhookSession(), $this->messageReceived())->assertOk();

        for ($round = 1; $round <= 5; $round++) {
            $this->travel(3)->minutes();
            $this->artisan('whatsapp:replay-deliveries')->assertSuccessful();
        }

        // The original job plus two replays, then it is left alone (and kept for a human, with its body).
        Queue::assertPushed(ProcessWebhookDelivery::class, 3);
        $this->assertSame(2, WaWebhookDelivery::query()->sole()->replays);
    }

    public function test_a_delivery_that_ran_out_of_tries_is_replayed_later_and_succeeds(): void
    {
        $session = $this->webhookSession();
        $this->deliver($session, $this->messageReceived(['body' => 'second chance']))->assertOk();

        // The (sync) job already ran once and succeeded in this test; rebuild the "ran out of tries" state the way the job leaves it.
        WaMessage::query()->delete();
        WaChat::query()->delete();
        $raw = $this->rawBody($session, $this->messageReceived(['body' => 'second chance']));
        $delivery = WaWebhookDelivery::query()->sole();
        $delivery->forceFill(['outcome' => WebhookOutcome::Failed, 'processed_at' => now(), 'error' => 'RuntimeException: database is gone', 'body' => $raw, 'replays' => 0])->save();

        // Too early: the pause after a failure is five minutes.
        $this->artisan('whatsapp:replay-deliveries')->assertSuccessful();
        $this->assertSame(WebhookOutcome::Failed, $delivery->refresh()->outcome);

        $this->travel(6)->minutes();
        $this->artisan('whatsapp:replay-deliveries')->assertSuccessful();

        $delivery->refresh();
        $this->assertSame(WebhookOutcome::Processed, $delivery->outcome, 'the replayed job ran (sync queue) and finished it');
        $this->assertSame(1, $delivery->replays);
        $this->assertNull($delivery->body);
        $this->assertSame('second chance', WaMessage::query()->sole()->body);
    }

    public function test_a_failed_delivery_gets_a_growing_pause_and_a_bounded_number_of_replays_and_keeps_its_body(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $raw = $this->rawBody($session, $this->messageReceived());
        $delivery = WaWebhookDelivery::query()->create([
            'session_id' => $session->id, 'idempotency_key' => 'k1', 'event' => 'message.received', 'received_at' => now(),
            'outcome' => WebhookOutcome::Failed, 'processed_at' => now(), 'error' => 'boom', 'body' => $raw, 'replays' => 0,
        ]);

        $this->travel(6)->minutes();
        $this->assertSame(['requeued' => 0, 'retried' => 1], $this->app->make(ReplayWebhookDeliveries::class)->handle());
        $this->assertNull($delivery->refresh()->outcome, 'reopened for the new job');

        // It fails again; the next pause is twice as long (10 minutes after the second failure).
        $delivery->forceFill(['outcome' => WebhookOutcome::Failed, 'processed_at' => now()])->save();
        $this->travel(6)->minutes();
        $this->assertSame(0, $this->app->make(ReplayWebhookDeliveries::class)->handle()['retried']);
        $this->travel(5)->minutes();
        $this->assertSame(1, $this->app->make(ReplayWebhookDeliveries::class)->handle()['retried']);

        // Budget used up: it stays failed, with its body.
        $delivery->forceFill(['outcome' => WebhookOutcome::Failed, 'processed_at' => now()->subDay(), 'replays' => 5])->save();
        $this->assertSame(0, $this->app->make(ReplayWebhookDeliveries::class)->handle()['retried']);
        $this->assertSame($raw, $delivery->refresh()->body);
    }

    public function test_a_failed_job_keeps_the_body_for_the_replay(): void
    {
        $session = $this->webhookSession();
        Queue::fake();
        $this->deliver($session, $this->messageReceived())->assertOk();
        $delivery = WaWebhookDelivery::query()->sole();
        $processor = Mockery::mock(WebhookProcessor::class);
        $processor->shouldReceive('process')->andThrow(new \RuntimeException('database is gone'));

        $job = new ProcessWebhookDelivery($delivery->id);
        $queueJob = Mockery::mock(Job::class);
        $queueJob->shouldReceive('attempts')->andReturn(5);
        $queueJob->shouldReceive('release');
        $job->setJob($queueJob);
        $job->handle($processor);

        $delivery->refresh();
        $this->assertSame(WebhookOutcome::Failed, $delivery->outcome);
        $this->assertNotNull($delivery->body);
    }

    public function test_a_row_without_a_body_that_never_completed_is_closed_not_replayed(): void
    {
        Queue::fake();
        $session = $this->webhookSession();
        $delivery = WaWebhookDelivery::query()->create(['session_id' => $session->id, 'idempotency_key' => 'old', 'event' => 'message.received', 'received_at' => now()->subHour()]);

        $this->assertSame(['requeued' => 0, 'retried' => 0], $this->app->make(ReplayWebhookDeliveries::class)->handle());
        (new ProcessWebhookDelivery($delivery->id))->handle($this->app->make(WebhookProcessor::class));

        $this->assertSame(WebhookOutcome::Ignored, $delivery->refresh()->outcome);
    }

    public function test_the_replay_command_is_scheduled_every_five_minutes(): void
    {
        $event = collect($this->app->make(Schedule::class)->events())
            ->first(fn ($event): bool => str_contains((string) $event->command, 'whatsapp:replay-deliveries'));

        $this->assertNotNull($event);
        $this->assertSame('*/5 * * * *', $event->expression);
    }
}
