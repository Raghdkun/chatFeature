<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Http\Exceptions\ApiProblemException;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Illuminate\Database\UniqueConstraintViolationException;
use JsonException;
use Throwable;

/**
 * The accepted (signature-verified) side of an OpenWA webhook: the idempotency ledger and the hand-off to the queue.
 *
 * Everything is read from the SIGNED BODY (`{event, timestamp, sessionId, idempotencyKey, deliveryId, data}`), never from the request
 * headers: the headers are not covered by the signature, so whoever holds a captured delivery could change them. The event must be a
 * usable name (`400` otherwise, nothing stored); the dedupe key is the body's `idempotencyKey` (a body without one is keyed by its own
 * hash, so a replay cannot pick a fresh key either).
 *
 * The delivery is stored FIRST (unique `(session, idempotency key)`), together with its raw body: the request that inserts the row owns
 * the processing, a repeat of the same key is answered `duplicate` and does nothing. OpenWA's key is content-derived and stable across its
 * retries; the delivery id is not a dedupe key. The body stays on the row until the delivery is processed, so a job the queue lost, or a
 * delivery that ran out of tries, is replayed by `whatsapp:replay-deliveries` (and, when OpenWA repeats a delivery whose job never
 * completed and that is older than `whatsapp.webhook.redeliver_after_seconds`, by that repeat). A body that is not a JSON object (with
 * a valid signature) is recorded as `rejected` and acknowledged, so OpenWA stops retrying something that will not improve.
 *
 * When the queue itself cannot take the job the ledger row is removed again and the failure surfaces (a 5xx: OpenWA retries), so a
 * delivery is never marked "seen" without anybody owning it.
 */
final class ReceiveWebhookDelivery
{
    public const ACCEPTED = 'accepted';

    public const DUPLICATE = 'duplicate';

    public const REJECTED = 'rejected';

    /**
     * @return string One of {@see self::ACCEPTED}, {@see self::DUPLICATE}, {@see self::REJECTED}.
     */
    public function handle(WhatsAppSession $session, string $body): string
    {
        $payload = $this->decode($body);
        $malformed = $payload === null;
        $event = $malformed ? null : $this->event($payload);

        if (! $malformed && $event === null) {
            // Signed, but no event name to act on: not something this application can do anything with (and nothing to trust a header for).
            throw new ApiProblemException(400, 'invalid_webhook', __('The request could not be processed.'));
        }

        $key = WaWebhookDelivery::keyFor($this->idempotencyKey($payload, $body));

        try {
            $delivery = WaWebhookDelivery::query()->create([
                'session_id' => $session->id,
                'idempotency_key' => $key,
                'delivery_id' => $this->limit($payload['deliveryId'] ?? null, 64),
                'event' => $event ?? 'unknown',
                'outcome' => $malformed ? WebhookOutcome::Rejected : null,
                'received_at' => now(),
                'processed_at' => $malformed ? now() : null,
                'error' => $malformed ? 'The body is not a JSON object.' : null,
                'body' => $malformed ? null : $body,
            ]);
        } catch (UniqueConstraintViolationException) {
            return $this->repeat($session, $key);
        }

        if ($malformed) {
            return self::REJECTED;
        }

        $this->dispatch($delivery);

        return self::ACCEPTED;
    }

    /** A repeated key: a no-op, unless the first attempt's job never completed (then this repeat owns it). */
    private function repeat(WhatsAppSession $session, string $key): string
    {
        $existing = WaWebhookDelivery::query()->where('session_id', $session->id)->where('idempotency_key', $key)->first();

        if ($existing === null || $existing->outcome !== null) {
            return self::DUPLICATE;
        }

        $stale = now()->subSeconds(max(30, (int) config('whatsapp.webhook.redeliver_after_seconds', 300)));

        // Only one of several repeats wins the right to queue it again: the guarded update of the very timestamp that made it stale.
        $claimed = WaWebhookDelivery::query()
            ->whereKey($existing->id)
            ->whereNull('outcome')
            ->where('received_at', '<=', $stale)
            ->update(['received_at' => now()]);

        if ($claimed === 1) {
            $this->dispatch($existing);

            return self::ACCEPTED;
        }

        return self::DUPLICATE;
    }

    private function dispatch(WaWebhookDelivery $delivery): void
    {
        try {
            ProcessWebhookDelivery::dispatch($delivery->id);
        } catch (Throwable $exception) {
            WaWebhookDelivery::query()->whereKey($delivery->id)->whereNull('outcome')->delete();

            throw $exception;
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function decode(string $body): ?array
    {
        try {
            $decoded = json_decode($body, true, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return null;
        }

        return is_array($decoded) && ($decoded === [] || ! array_is_list($decoded)) ? $decoded : null;
    }

    /**
     * The event name of the signed body, when it is one: a short token of letters, digits, dots, hyphens and underscores.
     *
     * @param  array<string, mixed>  $payload
     */
    private function event(array $payload): ?string
    {
        $event = $payload['event'] ?? null;

        return is_string($event) && preg_match('/^[A-Za-z][A-Za-z0-9._-]{0,47}$/D', $event) === 1 ? $event : null;
    }

    /**
     * The dedupe key: the `idempotencyKey` OpenWA put in the signed body. A body without one is not from OpenWA's own senders; it is
     * keyed by its content, so no header can make a replay look new.
     *
     * @param  array<string, mixed>|null  $payload
     */
    private function idempotencyKey(?array $payload, string $body): string
    {
        $candidate = $payload['idempotencyKey'] ?? null;

        if (is_string($candidate) && trim($candidate) !== '') {
            return trim($candidate);
        }

        return 'body:'.hash('sha256', $body);
    }

    private function limit(mixed $value, int $max): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }

        return mb_substr(trim($value), 0, $max);
    }
}
