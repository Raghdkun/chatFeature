<?php

namespace App\Domain\WhatsApp\Support\OpenWa;

use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;

/** A webhook registration as OpenWA reports it. `secret` and `headers` are write-only at OpenWA: they are never part of an answer. */
final readonly class OpenWaWebhook
{
    /**
     * @param  list<string>  $events
     */
    public function __construct(
        public string $id,
        public string $url,
        public array $events,
        public bool $active,
        public int $retryCount,
    ) {}

    /**
     * @param  array<array-key, mixed>  $payload
     *
     * @throws OpenWaUnavailable when there is no webhook id in it
     */
    public static function fromArray(array $payload): self
    {
        $id = $payload['id'] ?? null;

        if (! is_string($id) || $id === '') {
            throw new OpenWaUnavailable('OpenWA returned a webhook without an id.');
        }

        $events = is_array($payload['events'] ?? null) ? array_values(array_filter($payload['events'], 'is_string')) : [];

        return new self(
            id: $id,
            url: is_string($payload['url'] ?? null) ? $payload['url'] : '',
            events: $events,
            active: ($payload['active'] ?? true) !== false,
            retryCount: is_numeric($payload['retryCount'] ?? null) ? (int) $payload['retryCount'] : 3,
        );
    }
}
