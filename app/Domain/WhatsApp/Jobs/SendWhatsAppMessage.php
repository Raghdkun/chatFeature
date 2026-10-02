<?php

namespace App\Domain\WhatsApp\Jobs;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Domain\WhatsApp\Services\SendPacer;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRequestNotConfirmed;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Carbon\CarbonImmutable;
use DateTimeInterface;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\Jobs\SyncJob;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Sends a stored reply through OpenWA (decision P6-D5). One message, one job, and the rules that keep a number from being banned:
 *
 *  - the session must still be `ready`, else the message fails with that reason;
 *  - the per-session minimum interval ({@see SendPacer}): a job that arrives early is released until its slot (the `sync` queue sleeps);
 *  - `201` from OpenWA means accepted, not delivered: the row becomes `sent` and stores OpenWA's id; `delivered` / `read` / `failed` follow
 *    as acks arrive;
 *  - `429 SEND_PACING_LIMITED` is NOT retried blindly: a wait of at most `whatsapp.send.max_defer_seconds` reschedules the job after it,
 *    a longer one fails the message with a reason that says how long (it can be hours);
 *  - the plain throttler `429` clears in seconds: retried shortly; an OpenWA that cannot be reached is retried with backoff for
 *    `whatsapp.send.retry_for_minutes`, then the message fails; any other refusal fails it at once with OpenWA's reason;
 *  - a request that was sent but never answered ({@see OpenWaRequestNotConfirmed}) is NOT repeated (the customer could get the message
 *    twice): the row stays `pending` and OpenWA's `message.sent` webhook confirms it; the reconciliation fails it after
 *    `whatsapp.send.unconfirmed_after_minutes` if nothing ever does.
 *
 * A message that did not reach WhatsApp gives its daily-cap slot back. The job never throws for a failure it handled.
 */
class SendWhatsAppMessage implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    /** Unlimited tries, bounded in time by {@see self::retryUntil()}: a released job counts as an attempt and must not run out. */
    public int $tries = 0;

    public int $timeout = 90;

    private readonly int $deadline;

    public function __construct(public readonly int $messageId)
    {
        $this->deadline = now()->addMinutes(max(1, (int) config('whatsapp.send.retry_for_minutes', 20)))->getTimestamp();
    }

    public function retryUntil(): DateTimeInterface
    {
        return CarbonImmutable::createFromTimestamp($this->deadline);
    }

    public function handle(OpenWaClient $openWa, SendPacer $pacer, SendCounter $counter): void
    {
        $message = WaMessage::query()->with('chat.session')->find($this->messageId);

        if ($message === null || $message->status !== WaMessageStatus::Pending || $message->wa_message_id !== null || $message->body === null) {
            return;
        }

        $session = $message->chat->session;

        if ($session->trashed() || $session->status !== SessionStatus::Ready || $session->openwa_session_id === null) {
            $this->fail($message, $counter, __('The WhatsApp number was not connected when the message was sent.'));

            return;
        }

        if (! $this->takeSlot($pacer, $session)) {
            return;
        }

        try {
            $result = $openWa->sendText($session->openwa_session_id, $message->chat->chat_id, $message->body);
        } catch (OpenWaPacingLimited $limited) {
            $this->pacingLimited($message, $counter, $limited);

            return;
        } catch (OpenWaRejected $rejected) {
            $this->rejected($message, $counter, $rejected);

            return;
        } catch (OpenWaRequestNotConfirmed) {
            return;
        } catch (OpenWaUnavailable $unavailable) {
            $this->unavailable($message, $counter, $unavailable);

            return;
        }

        $this->accepted($message, $result);
    }

    /** Called by the queue when the deadline passed or the worker gave up: whatever is still pending did not go out. */
    public function failed(Throwable $exception): void
    {
        $message = WaMessage::query()->find($this->messageId);

        if ($message !== null && $message->status === WaMessageStatus::Pending && $message->wa_message_id === null) {
            $this->fail($message, app(SendCounter::class), __('WhatsApp could not be reached in time, so the message was not sent.'));
        }
    }

    /**
     * Wait for the session's slot. False = the job was released (it runs again when the slot is due) and must stop now.
     */
    private function takeSlot(SendPacer $pacer, WhatsAppSession $session): bool
    {
        $wait = $pacer->acquire($session);

        if ($wait <= 0) {
            return true;
        }

        if (! $this->canRelease()) {
            // The `sync` queue (or a direct call) cannot hand the job back: sleep for the slot, bounded.
            $cap = max(100, (int) config('whatsapp.send.inline_wait_ms', 10000));

            for ($attempt = 0; $attempt < 5 && $wait > 0; $attempt++) {
                usleep(min($wait, $cap) * 1000);
                $wait = $pacer->acquire($session);
            }

            return true;
        }

        $this->release((int) ceil($wait / 1000));

        return false;
    }

    private function accepted(WaMessage $message, OpenWaSendResult $result): void
    {
        try {
            $updated = WaMessage::query()
                ->whereKey($message->id)
                ->where('status', WaMessageStatus::Pending->value)
                ->whereNull('wa_message_id')
                ->update(['wa_message_id' => $result->messageId, 'status' => WaMessageStatus::Sent->value, 'updated_at' => now()]);
        } catch (UniqueConstraintViolationException) {
            // The `message.sent` echo of this very reply was recorded as a message of its own before we stored the id: it becomes this row.
            $this->mergeEcho($message, $result->messageId);

            return;
        }

        if ($updated === 1) {
            WaMessageStatusChanged::dispatch($message->refresh(), WaMessageStatus::Pending);
        }
    }

    private function mergeEcho(WaMessage $message, string $waMessageId): void
    {
        $from = WaMessageStatus::Pending;

        DB::transaction(function () use ($message, $waMessageId): void {
            $echo = WaMessage::query()->where('wa_chat_id', $message->wa_chat_id)->where('wa_message_id', $waMessageId)->lockForUpdate()->first();
            $status = $echo === null ? WaMessageStatus::Sent : WaMessageStatus::Sent->advance($echo->status);

            $echo?->delete();
            WaMessage::query()->whereKey($message->id)->whereNull('wa_message_id')->update(['wa_message_id' => $waMessageId, 'status' => $status->value, 'updated_at' => now()]);
        });

        WaMessageStatusChanged::dispatch($message->refresh(), $from);
    }

    private function pacingLimited(WaMessage $message, SendCounter $counter, OpenWaPacingLimited $limited): void
    {
        $wait = $limited->retryAfterSeconds;

        if ($wait <= max(1, (int) config('whatsapp.send.max_defer_seconds', 300)) && $this->canRelease()) {
            $this->release($wait + 1);

            return;
        }

        $this->fail($message, $counter, __('WhatsApp\'s own sending limit applies to this number (:reason). Try again in about :time.', [
            'reason' => mb_substr($limited->getMessage(), 0, 200),
            'time' => $this->duration($wait),
        ]));
    }

    private function rejected(WaMessage $message, SendCounter $counter, OpenWaRejected $rejected): void
    {
        // The plain throttler's 429 (no `code`) clears within seconds.
        if ($rejected->status === 429 && $this->canRelease()) {
            $this->release(5 + random_int(0, 10));

            return;
        }

        $this->fail($message, $counter, OpenWaProblem::reason($rejected));
    }

    private function unavailable(WaMessage $message, SendCounter $counter, OpenWaUnavailable $unavailable): void
    {
        if ($this->canRelease() && time() < $this->deadline) {
            $this->release(min(300, 10 * max(1, $this->attempts()) ** 2));

            return;
        }

        $this->fail($message, $counter, OpenWaProblem::reason($unavailable));
    }

    /** The message did not go out: failed with a reason an administrator can read, and its slot of the daily cap given back. */
    private function fail(WaMessage $message, SendCounter $counter, string $reason): void
    {
        $failed = WaMessage::query()
            ->whereKey($message->id)
            ->where('status', WaMessageStatus::Pending->value)
            ->update(['status' => WaMessageStatus::Failed->value, 'error' => mb_substr($reason, 0, 500), 'updated_at' => now()]);

        if ($failed !== 1) {
            return;
        }

        $session = $message->chat->session;
        $counter->release($session->id, $message->created_at ?? now());
        WaMessageStatusChanged::dispatch($message->refresh(), WaMessageStatus::Pending);
    }

    /** A queued job can be handed back to the queue; the `sync` queue and a direct call cannot. */
    private function canRelease(): bool
    {
        return $this->job !== null && ! $this->job instanceof SyncJob;
    }

    private function duration(int $seconds): string
    {
        return match (true) {
            $seconds >= 7200 => __(':n hours', ['n' => (int) round($seconds / 3600)]),
            $seconds >= 120 => __(':n minutes', ['n' => (int) round($seconds / 60)]),
            default => __(':n seconds', ['n' => max(1, $seconds)]),
        };
    }
}
