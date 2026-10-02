<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Domain\WhatsApp\Services\WebhookProcessor;
use App\Models\WaWebhookDelivery;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Mockery;
use Tests\Support\OpenWaWebhooks;
use Tests\TestCase;

/**
 * A delivery whose processing throws is recorded with a safe error, retried with the configured backoff and, after the last try, ends as
 * `failed` WITHOUT leaving the customer's text in the log or in `failed_jobs`.
 */
class WebhookJobFailureTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase;

    private function failing(string $message): WebhookProcessor
    {
        $processor = Mockery::mock(WebhookProcessor::class);
        $processor->shouldReceive('process')->andThrow(new \RuntimeException($message));

        return $processor;
    }

    private function jobFor(string $secretBody): array
    {
        $session = $this->webhookSession();
        $raw = (string) json_encode($this->messageReceived(['body' => $secretBody]));
        $delivery = WaWebhookDelivery::query()->create(['session_id' => $session->id, 'idempotency_key' => 'k', 'event' => 'message.received', 'received_at' => now()]);

        return [new ProcessWebhookDelivery($delivery->id, $raw), $delivery];
    }

    public function test_a_failure_is_recorded_and_the_job_released_with_the_backoff(): void
    {
        config(['whatsapp.webhook.tries' => 5, 'whatsapp.webhook.backoff' => [5, 20, 60, 180]]);
        [$job, $delivery] = $this->jobFor('hello');

        foreach ([1 => 5, 2 => 20, 3 => 60, 4 => 180] as $attempt => $wait) {
            $queueJob = Mockery::mock(Job::class);
            $queueJob->shouldReceive('attempts')->andReturn($attempt);
            $queueJob->shouldReceive('release')->once()->with($wait);
            $job->setJob($queueJob);

            $job->handle($this->failing('database is gone'));

            $delivery->refresh();
            $this->assertNull($delivery->outcome);
            $this->assertSame('RuntimeException: database is gone', $delivery->error);
        }
    }

    public function test_the_last_failure_ends_as_failed_and_the_job_ends_normally(): void
    {
        config(['whatsapp.webhook.tries' => 5]);
        Log::spy();
        [$job, $delivery] = $this->jobFor('top secret customer text');

        $queueJob = Mockery::mock(Job::class);
        $queueJob->shouldReceive('attempts')->andReturn(5);
        $queueJob->shouldNotReceive('release');
        $job->setJob($queueJob);

        $job->handle($this->failing('boom'));

        $delivery->refresh();
        $this->assertSame(WebhookOutcome::Failed, $delivery->outcome);
        $this->assertSame('RuntimeException: boom', $delivery->error);
        $this->assertNotNull($delivery->processed_at);
        $this->assertSame(0, DB::table('failed_jobs')->count());
        Log::shouldHaveReceived('warning')->once()->withArgs(fn (string $message, array $context): bool => ! str_contains(json_encode($context), 'top secret'));
    }

    public function test_sql_with_the_customers_text_never_reaches_the_ledger_or_the_log(): void
    {
        Log::spy();
        [$job, $delivery] = $this->jobFor('hello');
        $sql = "SQLSTATE[HY000]: General error: 1364 Field 'x' doesn't have a default value (Connection: mysql, SQL: insert into `wa_messages` (`body`) values (top secret customer text))";

        $job->handle($this->failing($sql));

        $delivery->refresh();
        $this->assertSame(WebhookOutcome::Failed, $delivery->outcome, 'run directly (no queue job) the first failure is final');
        $this->assertStringNotContainsString('top secret', (string) $delivery->error);
        $this->assertStringNotContainsString('insert into', (string) $delivery->error);
        Log::shouldHaveReceived('warning')->withArgs(fn (string $message, array $context): bool => ! str_contains(json_encode($context), 'top secret'));
    }

    public function test_a_delivery_that_is_already_finished_is_not_processed_again(): void
    {
        [$job, $delivery] = $this->jobFor('hello');
        $delivery->update(['outcome' => WebhookOutcome::Processed, 'processed_at' => now()]);

        $processor = Mockery::mock(WebhookProcessor::class);
        $processor->shouldNotReceive('process');
        $job->handle($processor);

        $this->assertSame(WebhookOutcome::Processed, $delivery->refresh()->outcome);
    }

    public function test_the_failed_hook_marks_the_delivery_failed(): void
    {
        [$job, $delivery] = $this->jobFor('hello');

        $job->failed(new \RuntimeException('worker killed'));

        $this->assertSame(WebhookOutcome::Failed, $delivery->refresh()->outcome);
    }

    public function test_a_delivery_of_a_deleted_session_is_ignored(): void
    {
        [$job, $delivery] = $this->jobFor('hello');
        $delivery->session->delete();

        $job->handle(app(WebhookProcessor::class));

        $this->assertSame(WebhookOutcome::Ignored, $delivery->refresh()->outcome);
    }
}
