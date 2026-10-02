<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Illuminate\Database\UniqueConstraintViolationException;
use JsonException;
use Throwable;

/**
 * The accepted (signature-verified) side of an OpenWA webhook: the idempotency ledger and the hand-off to the queue.
 *
 * The delivery is stored FIRST (unique `(session, idempotency key)`): the request that inserts the row owns the processing, a repeat
 * of the same key is answered `duplicate` and does nothing. OpenWA's key is content-derived and stable across its retries; the delivery
 * id is not a dedupe key. When the row exists but its job never completed (the queue lost it) and it is older than
 * `whatsapp.webhook.redeliver_after_seconds`, OpenWA's repeat re-queues it instead. A body that is not a JSON object (with a valid
 * signature) is recorded as `rejected` and acknowledged, so OpenWA stops retrying something that will not improve.
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
    public function handle(WhatsAppSession $session, string $body, ?string $headerKey, ?string $headerEvent, ?string $headerDeliveryId): string
    {
        $payload = $this->decode($body);
        $key = WaWebhookDelivery::keyFor($this->idempotencyKey($payload, $headerKey, $body));
        $malformed = $payload === null;

        try {
            $delivery = WaWebhookDelivery::query()->create([
                'session_id' => $session->id,
                'idempotency_key' => $key,
                'delivery_id' => $this->limit($headerDeliveryId ?? ($payload['deliveryId'] ?? null), 64),
                'event' => $this->limit($payload['event'] ?? $headerEvent, 48) ?? 'unknown',
                'outcome' => $malformed ? WebhookOutcome::Rejected : null,
                'received_at' => now(),
                'processed_at' => $malformed ? now() : null,
                'error' => $malformed ? 'The body is not a JSON object.' : null,
            ]);
        } catch (UniqueConstraintViolationException) {
            return $this->repeat($session, $key, $body);
        }

        if ($malformed) {
            return self::REJECTED;
        }

        $this->dispatch($delivery, $body);

        return self::ACCEPTED;
    }

    /** A repeated key: a no-op, unless the first attempt's job never completed (then this repeat owns it). */
    private function repeat(WhatsAppSession $session, string $key, string $body): string
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
            $this->dispatch($existing, $body);

            return self::ACCEPTED;
        }

        return self::DUPLICATE;
    }

    private function dispatch(WaWebhookDelivery $delivery, string $body): void
    {
        try {
            ProcessWebhookDelivery::dispatch($delivery->id, $body);
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
     * @param  array<string, mixed>|null  $payload
     */
    private function idempotencyKey(?array $payload, ?string $header, string $body): string
    {
        foreach ([$header, is_string($payload['idempotencyKey'] ?? null) ? $payload['idempotencyKey'] : null] as $candidate) {
            if (is_string($candidate) && trim($candidate) !== '') {
                return trim($candidate);
            }
        }

        // OpenWA always sends a key; a body without one is deduplicated by its content.
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
