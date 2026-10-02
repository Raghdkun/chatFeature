<?php

namespace App\Domain\Notifications\Channels;

use App\Domain\Notifications\Contracts\PushChannel;
use App\Domain\Notifications\Support\PushEndpointGuard;
use App\Domain\Notifications\Support\PushHttpClient;
use App\Domain\Notifications\Support\PushMessage;
use App\Domain\Notifications\Support\PushResult;
use App\Models\PushSubscription;
use GuzzleHttp\Psr7\HttpFactory;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Log;
use Minishlink\WebPush\MessageSentReport;
use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;
use Throwable;

/**
 * Web Push (RFC 8030, VAPID RFC 8292) to the browsers a staff member subscribed (`push_subscriptions`), through `minishlink/web-push`
 * (the library behind laravel-notification-channels/webpush; this app's subscription table keeps its keys encrypted, so it does not use
 * that package's model). One call sends one message to every subscription of one user; the HTTP client is Laravel's, so `Http::fake`
 * covers it and a push service that hangs costs at most the configured timeout per request (and, with a deadline, at most that much for the
 * whole call). Redirects are never followed, and every connection is pinned to the addresses the endpoint guard judged just before
 * ({@see PushHttpClient}); an endpoint the guard refuses is never contacted.
 *
 * What happens to the answer of a push service:
 *  - 2xx: delivered (`last_used_at` is refreshed);
 *  - 404 / 410: the browser dropped the subscription: the row is deleted (the page registers a new one the next time it is opened);
 *  - no answer, 429 or 5xx: worth another try (`PushResult::$retry`);
 *  - anything else (400 / 401 / 403 / 413 ...): refused for good, logged without the endpoint (it is a secret).
 *
 * `deliver()` never throws.
 */
final class WebPushChannel implements PushChannel
{
    public function __construct(private readonly PushEndpointGuard $endpoints) {}

    public function name(): string
    {
        return 'web';
    }

    public function isEnabled(): bool
    {
        return self::vapidConfigured();
    }

    /** Whether both VAPID keys are set: the one switch of the whole feature. */
    public static function vapidConfigured(): bool
    {
        return (string) config('push.vapid.public_key', '') !== '' && (string) config('push.vapid.private_key', '') !== '';
    }

    public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult
    {
        if (! $this->isEnabled()) {
            return PushResult::disabled();
        }

        try {
            return $this->send($userId, $message, $targetIds, $timeoutSeconds, $deadlineSeconds);
        } catch (Throwable $exception) {
            // The push service being down (or a library error) must never reach the caller.
            Log::warning('push.web.failed', ['user' => $userId, 'type' => $message->type->value, 'error' => $exception::class.': '.$this->scrub($exception->getMessage())]);

            return new PushResult(failed: 1);
        }
    }

    /**
     * @param  list<int>|null  $targetIds
     */
    private function send(int $userId, PushMessage $message, ?array $targetIds, ?int $timeoutSeconds, ?int $deadlineSeconds): PushResult
    {
        $subscriptions = PushSubscription::query()
            ->ownedBy($userId)
            ->when($targetIds !== null, fn ($query) => $query->whereKey($targetIds))
            ->get();

        if ($subscriptions->isEmpty()) {
            return new PushResult;
        }

        $deadlineAt = $deadlineSeconds === null ? null : microtime(true) + max(1, $deadlineSeconds);
        $payload = json_encode($message->payload(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $options = ['TTL' => max(0, $message->ttl), 'urgency' => $message->urgency, 'topic' => $message->topic()];

        /** @var list<PushSubscription> $eligible the subscriptions whose endpoint the guard let through */
        $eligible = [];
        $pins = [];
        $failed = 0;
        $retry = [];

        foreach ($subscriptions as $subscription) {
            // The time budget also covers the DNS lookups of the guard: what cannot be started in time is tried again later.
            if ($deadlineAt !== null && microtime(true) >= $deadlineAt) {
                $retry[] = $subscription->id;

                continue;
            }

            // One judgement per host (cached): its addresses are what the connection is pinned to.
            $target = $this->endpoints->inspect($subscription->endpoint);

            if (! $target->ok) {
                $failed++;

                continue;
            }

            if (($pin = $target->curlResolveEntry()) !== null) {
                $pins[$pin] = true;
            }

            $eligible[] = $subscription;
        }

        $webPush = $this->client($timeoutSeconds, array_map(strval(...), array_keys($pins)), $deadlineAt);

        /** @var list<PushSubscription> $queued in the order they were queued: the library reports in that order */
        $queued = [];

        foreach ($eligible as $subscription) {
            try {
                $webPush->queueNotification(
                    new Subscription($subscription->endpoint, $subscription->p256dh, $subscription->auth, $subscription->content_encoding),
                    $payload,
                    $options,
                );
            } catch (DecryptException) {
                // The keys cannot be read any more (the application key changed): the subscription is useless, the page makes a new one.
                $subscription->delete();

                continue;
            }

            $queued[] = $subscription;
        }

        $sent = 0;
        $pruned = 0;
        $deliveredIds = [];

        foreach ($webPush->flush() as $position => $report) {
            $subscription = $queued[$position] ?? null;

            // 2xx only: the library calls any answer below 400 a success, but a redirect (never followed) is not a delivery.
            if ($report->isSuccess() && ($report->getResponse()?->getStatusCode() ?? 201) < 300) {
                $sent++;

                if ($subscription !== null) {
                    $deliveredIds[] = $subscription->id;
                }
            } elseif ($report->isSubscriptionExpired()) {
                $pruned++;
                $subscription?->delete();
            } elseif ($this->isRetryable($report)) {
                if ($subscription !== null) {
                    $retry[] = $subscription->id;
                } else {
                    $failed++;
                }
            } else {
                $failed++;
                Log::warning('push.web.refused', ['user' => $userId, 'status' => $report->getResponse()?->getStatusCode(), 'reason' => $this->scrub($report->getReason())]);
            }
        }

        if ($deliveredIds !== []) {
            PushSubscription::query()->whereKey($deliveredIds)->update(['last_used_at' => now()]);
        }

        return new PushResult(sent: $sent, pruned: $pruned, failed: $failed, retry: $retry);
    }

    private function isRetryable(MessageSentReport $report): bool
    {
        $status = $report->getResponse()?->getStatusCode();

        return $status === null || $status === 429 || $status >= 500;
    }

    /**
     * @param  list<string>  $pins  `host:port:address` entries the connections are pinned to
     */
    private function client(?int $timeoutSeconds, array $pins, ?float $deadlineAt): WebPush
    {
        $timeout = max(1, $timeoutSeconds ?? (int) config('push.web.timeout', 10));

        $client = new PushHttpClient($timeout, $pins, $deadlineAt);
        $webPush = new WebPush(['VAPID' => $this->vapid()], [], $client, new HttpFactory, new HttpFactory);

        return $webPush->setReuseVAPIDHeaders(true)->setAutomaticPadding(true);
    }

    /**
     * @return array{subject: string, publicKey: string, privateKey: string}
     */
    private function vapid(): array
    {
        $subject = (string) config('push.vapid.subject', '');

        if ($subject === '') {
            $subject = settings()->string('app.url', (string) config('app.url'));
        }

        return [
            'subject' => $subject !== '' ? $subject : 'mailto:admin@localhost',
            'publicKey' => (string) config('push.vapid.public_key'),
            'privateKey' => (string) config('push.vapid.private_key'),
        ];
    }

    /** A message from the HTTP layer can quote the request URL, which is a secret endpoint: keep only what says what went wrong. */
    private function scrub(string $text): string
    {
        return (string) preg_replace('~https?://\S+~i', '[endpoint]', $text);
    }
}
