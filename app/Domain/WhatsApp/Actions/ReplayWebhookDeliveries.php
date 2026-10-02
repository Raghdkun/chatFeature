<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Models\WaWebhookDelivery;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * `whatsapp:replay-deliveries` (scheduled every five minutes): makes the inbound side durable once OpenWA has been answered `200`.
 *
 * A delivery is acknowledged as soon as it is stored with its raw body, and processed later by a queued job. Two things can then go
 * wrong, and OpenWA will not repeat the delivery for either (it already got its `200`):
 *
 *  - the job was lost (a flushed or crashed queue): the row has no outcome for good. Rows without an outcome older than
 *    `whatsapp.webhook.replay.stuck_after_seconds` (2 minutes) are queued again;
 *  - the delivery ran out of tries and ended `failed` (OpenWA was unreachable for a media fetch, a database blip, a deploy): it is tried
 *    again after a growing pause (`whatsapp.webhook.replay.failed_after_seconds` x the replays used so far).
 *
 * Both are bounded by a budget (`whatsapp.webhook.replay.max`, 5 replays per delivery) and claimed with a guarded `UPDATE`, so two
 * schedulers never queue the same delivery twice. Only rows that still hold their body can be replayed; the body is cleared by every
 * outcome but `failed`, and by the retention rules of `whatsapp:prune`. The processing itself is idempotent (unique message index,
 * forward-only statuses, the ledger), so a replay of a delivery that did in fact complete is harmless.
 */
final class ReplayWebhookDeliveries
{
    /**
     * @return array{requeued: int, retried: int}
     */
    public function handle(): array
    {
        return ['requeued' => $this->lost(), 'retried' => $this->failed()];
    }

    /** Accepted long ago, never completed: the queue lost the job. */
    private function lost(): int
    {
        $stale = now()->subSeconds($this->seconds('stuck_after_seconds', 120));
        $queued = 0;

        WaWebhookDelivery::query()
            ->whereNull('outcome')
            ->whereNotNull('body')
            ->where('received_at', '<=', $stale)
            ->where('replays', '<', $this->max())
            ->orderBy('id')
            ->limit($this->batch())
            ->get(['id'])
            ->each(function (WaWebhookDelivery $delivery) use ($stale, &$queued): void {
                // Only one scheduler (or one OpenWA repeat) wins the right to queue it: the guarded update of the very timestamp that made it stale.
                $claimed = WaWebhookDelivery::query()
                    ->whereKey($delivery->id)
                    ->whereNull('outcome')
                    ->where('received_at', '<=', $stale)
                    ->where('replays', '<', $this->max())
                    ->update(['received_at' => now(), 'replays' => DB::raw('replays + 1')]);

                if ($claimed === 1 && $this->dispatch($delivery->id)) {
                    $queued++;
                }
            });

        return $queued;
    }

    /** Ended `failed` and the budget is not used up: give it another go after the pause. */
    private function failed(): int
    {
        $pause = $this->seconds('failed_after_seconds', 300);
        $retried = 0;

        WaWebhookDelivery::query()
            ->where('outcome', WebhookOutcome::Failed->value)
            ->whereNotNull('body')
            ->where('replays', '<', $this->max())
            ->where('processed_at', '<=', now()->subSeconds($pause))
            ->orderBy('id')
            ->limit($this->batch())
            ->get(['id', 'replays', 'processed_at'])
            ->each(function (WaWebhookDelivery $delivery) use ($pause, &$retried): void {
                // 5 minutes after the first failure, 10 after the second, ...
                if ($delivery->processed_at === null || $delivery->processed_at->gt(now()->subSeconds($pause * ($delivery->replays + 1)))) {
                    return;
                }

                $reopened = WaWebhookDelivery::query()
                    ->whereKey($delivery->id)
                    ->where('outcome', WebhookOutcome::Failed->value)
                    ->where('replays', $delivery->replays)
                    ->update(['outcome' => null, 'processed_at' => null, 'received_at' => now(), 'replays' => $delivery->replays + 1]);

                if ($reopened === 1 && $this->dispatch($delivery->id)) {
                    $retried++;
                }
            });

        return $retried;
    }

    /** A queue that cannot take the job leaves the row as it is (the next run tries again). */
    private function dispatch(int $deliveryId): bool
    {
        try {
            ProcessWebhookDelivery::dispatch($deliveryId);

            return true;
        } catch (Throwable $exception) {
            Log::warning('A WhatsApp webhook delivery could not be queued again.', ['delivery' => $deliveryId, 'error' => $exception::class]);

            return false;
        }
    }

    private function seconds(string $key, int $default): int
    {
        return max(30, (int) config('whatsapp.webhook.replay.'.$key, $default));
    }

    private function max(): int
    {
        return max(1, (int) config('whatsapp.webhook.replay.max', 5));
    }

    private function batch(): int
    {
        return max(1, (int) config('whatsapp.webhook.replay.batch', 200));
    }
}
