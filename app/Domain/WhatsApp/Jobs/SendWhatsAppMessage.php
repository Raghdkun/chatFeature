<?php

namespace App\Domain\WhatsApp\Jobs;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
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
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
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
 *  - the plain throttler `429` clears in seconds and a `409` (the engine is up but WhatsApp is not connected: reconnecting) passes by itself:
 *    both are retried; an OpenWA that cannot be reached is retried with backoff for `whatsapp.send.retry_for_minutes`, then the message
 *    fails; a `400` "session is not active" (OpenWA has no engine) fails it with that reason and reconciles the session; any other
 *    refusal fails it at once with OpenWA's reason;
 *  - a request that MAY have reached WhatsApp is NOT repeated (the customer could get the message twice): the row stays `pending` and
 *    OpenWA's `message.sent` webhook confirms it; the reconciliation fails it after `whatsapp.send.unconfirmed_after_minutes` if nothing
 *    ever does. That is every {@see OpenWaRequestNotConfirmed}: a request sent but never answered, a `5xx` (a proxy's 502 / 504) or a
 *    `2xx` without a usable message id, and a failure of our own bookkeeping after OpenWA said `201`. Only what certainly did NOT reach
 *    WhatsApp is retried: a connection that never got through, `409` (not connected) and the plain throttler `429`;
 *  - replies to one customer go out in the order they were written: while an older reply of the same chat is still `pending` (waiting for
 *    its slot or being retried) this one waits too ({@see self::waitsForAnOlderReply()}). A reply that was handed over but never
 *    confirmed does not hold the ones behind it;
 *
 * A message that did not reach WhatsApp gives its daily-cap slot back. The job never throws for a failure it handled.
 */
class SendWhatsAppMessage implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    /** Unlimited tries, bounded in time by {@see self::retryUntil()}: a released job counts as an attempt and must not run out. */
    public int $tries = 0;

    public int $timeout = 90;

    /** The cache marker of a reply that was handed to OpenWA but not confirmed (it must not hold back the replies behind it). */
    private const UNCONFIRMED_PREFIX = 'wa:unconfirmed:';

    private const UNCONFIRMED_TTL_SECONDS = 7200;

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

        if ($this->waitsForAnOlderReply($message)) {
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
            $this->unconfirmed($message);

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

    /**
     * OpenWA accepted the message: store its id and move the row on. Whatever goes wrong HERE (the database, a listener) is OURS, and the
     * message is on its way: the failure is logged and the row stays `pending`, never retried (the `message.sent` webhook or the
     * reconciliation settles it), because repeating the send would deliver it twice.
     */
    private function accepted(WaMessage $message, OpenWaSendResult $result): void
    {
        try {
            $this->store($message, $result);
        } catch (Throwable $exception) {
            report($exception);
            $this->unconfirmed($message);
        }
    }

    private function store(WaMessage $message, OpenWaSendResult $result): void
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

    /**
     * The message may have reached WhatsApp (or certainly did, and only our bookkeeping failed): it is left `pending`, never sent again,
     * and no longer holds back the replies queued behind it.
     */
    private function unconfirmed(WaMessage $message): void
    {
        Cache::put(self::UNCONFIRMED_PREFIX.$message->id, true, self::UNCONFIRMED_TTL_SECONDS);
        Log::warning('A WhatsApp reply may have been sent but is not confirmed; it stays pending and is not sent again.', ['message' => $message->ulid]);
    }

    /**
     * Replies of one chat go out in the order they were written: an older reply that is still `pending` (waiting for its pacing slot, or
     * being retried) is sent first, so a reply that happened to wake up earlier cannot overtake it. The job is released for a moment and
     * looks again. A reply that was handed over but never confirmed ({@see self::unconfirmed()}) does not count, and the `sync` queue
     * (where a job runs inline, in order, and cannot be released) never waits.
     */
    private function waitsForAnOlderReply(WaMessage $message): bool
    {
        if (! $this->canRelease()) {
            return false;
        }

        $older = WaMessage::query()
            ->where('wa_chat_id', $message->wa_chat_id)
            ->where('direction', WaDirection::Out->value)
            ->where('status', WaMessageStatus::Pending->value)
            ->whereNull('wa_message_id')
            ->where('id', '<', $message->id)
            ->pluck('id');

        if (! $older->contains(fn (mixed $id): bool => ! Cache::has(self::UNCONFIRMED_PREFIX.$id))) {
            return false;
        }

        $this->release(2);

        return true;
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

        // 409: the engine runs but WhatsApp is not connected right now (reconnecting, or our `ready` is ahead of the reconciliation): a state
        // that passes. Retried within the budget; if it does not, the message fails with that reason.
        if ($rejected->isConflict() && $this->canRelease() && time() < $this->deadline) {
            $this->release(min(60, 10 * max(1, $this->attempts())));

            return;
        }

        // 400 "Session ... is not active. Start the session first.": OpenWA has no engine for this number, so our `ready` is wrong. The message
        // fails with the reason and the session is reconciled at once (it becomes `disconnected` or whatever OpenWA reports).
        if ($rejected->status === 400 && preg_match('/not active|not started|start the session/i', $rejected->getMessage()) === 1) {
            $this->fail($message, $counter, __('OpenWA has no running engine for this number (the session is not active). The session status is being refreshed: start it again if needed.'));
            ReconcileWhatsAppSession::dispatch($message->chat->session_id);

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
