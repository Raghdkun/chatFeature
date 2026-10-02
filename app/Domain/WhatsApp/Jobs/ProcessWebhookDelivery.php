<?php

namespace App\Domain\WhatsApp\Jobs;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Services\AckBeforeMessage;
use App\Domain\WhatsApp\Services\WebhookProcessor;
use App\Domain\WhatsApp\Support\SafeError;
use App\Models\WaWebhookDelivery;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\Jobs\SyncJob;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use JsonException;
use Throwable;

/**
 * Applies a stored webhook delivery (`ReceiveWebhookDelivery` queued it after the signature was verified): parses the body tolerantly,
 * hands it to {@see WebhookProcessor} and records the outcome in the ledger (`wa_webhook_deliveries`).
 *
 * Idempotent and safe to run twice (a lock keeps two workers off the same delivery, the recorders are idempotent, the outcome is a
 * guarded `UPDATE ... WHERE outcome IS NULL`). A failure is recorded in `error` and the job runs again a few times with the backoff of
 * `whatsapp.webhook.backoff`; the last failure becomes the outcome `failed` and the job ENDS normally, so the message text of a customer
 * does not end up in the `failed_jobs` table. An ack that is faster than its message is retried on its own, shorter schedule.
 * The body travels in the job: a delivery whose job was lost is queued again by OpenWA's own retry (`ReceiveWebhookDelivery`).
 */
class ProcessWebhookDelivery implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 6;

    public int $timeout = 120;

    public function __construct(
        public readonly int $deliveryId,
        public readonly string $body,
    ) {
        $this->tries = max(2, (int) config('whatsapp.webhook.tries', 5)) + 1;
    }

    public function handle(WebhookProcessor $processor): void
    {
        $delivery = WaWebhookDelivery::query()->with('session')->find($this->deliveryId);

        if ($delivery === null || $delivery->outcome !== null) {
            return;
        }

        $lock = Cache::lock('wa:delivery:'.$delivery->id, 150);

        if (! $lock->get()) {
            $this->retryLater(5);

            return;
        }

        try {
            $this->process($processor, $delivery);
        } finally {
            $lock->release();
        }
    }

    public function failed(Throwable $exception): void
    {
        $this->finish($this->deliveryId, WebhookOutcome::Failed, SafeError::describe($exception));
    }

    private function process(WebhookProcessor $processor, WaWebhookDelivery $delivery): void
    {
        $session = $delivery->session;

        if ($session->trashed()) {
            $this->finish($delivery->id, WebhookOutcome::Ignored, 'The session was deleted.');

            return;
        }

        try {
            $payload = json_decode($this->body, true, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            $this->finish($delivery->id, WebhookOutcome::Rejected, 'The body is not JSON.');

            return;
        }

        if (! is_array($payload)) {
            $this->finish($delivery->id, WebhookOutcome::Rejected, 'The body is not a JSON object.');

            return;
        }

        try {
            $result = $processor->process($session, $payload, $delivery->event);
        } catch (AckBeforeMessage) {
            $this->ackFirst($delivery);

            return;
        } catch (Throwable $exception) {
            $this->failure($delivery, $exception);

            return;
        }

        $this->finish($delivery->id, $result->outcome, $result->note);
    }

    /** An ack that overtook its message: look again after the schedule, then give up quietly. */
    private function ackFirst(WaWebhookDelivery $delivery): void
    {
        $schedule = array_values(array_map(intval(...), (array) config('whatsapp.webhook.ack_retry_seconds', [5, 20])));
        $wait = $schedule[$this->attempts() - 1] ?? null;

        if ($wait === null || $this->job instanceof SyncJob || $this->job === null) {
            $this->finish($delivery->id, WebhookOutcome::Ignored, 'The ack belongs to a message that was never recorded.');

            return;
        }

        $this->retryLater($wait);
    }

    private function failure(WaWebhookDelivery $delivery, Throwable $exception): void
    {
        $why = SafeError::describe($exception);
        $backoff = array_values(array_map(intval(...), (array) config('whatsapp.webhook.backoff', [5, 20, 60, 180])));
        $tries = max(2, (int) config('whatsapp.webhook.tries', 5));
        $wait = $backoff[min($this->attempts(), count($backoff)) - 1] ?? 60;

        if ($this->attempts() >= $tries || $this->job instanceof SyncJob || $this->job === null) {
            Log::warning('A WhatsApp webhook delivery failed for good.', ['delivery' => $delivery->id, 'event' => $delivery->event, 'error' => $why]);
            $this->finish($delivery->id, WebhookOutcome::Failed, $why);

            return;
        }

        WaWebhookDelivery::query()->whereKey($delivery->id)->whereNull('outcome')->update(['error' => $why]);
        $this->retryLater($wait);
    }

    private function retryLater(int $seconds): void
    {
        if ($this->job !== null) {
            $this->release(max(1, $seconds));
        }
    }

    private function finish(int $deliveryId, WebhookOutcome $outcome, ?string $note): void
    {
        WaWebhookDelivery::query()
            ->whereKey($deliveryId)
            ->whereNull('outcome')
            ->update(['outcome' => $outcome->value, 'processed_at' => now(), 'error' => $note]);
    }
}
