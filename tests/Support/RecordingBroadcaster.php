<?php

namespace Tests\Support;

use Illuminate\Broadcasting\Broadcasters\Broadcaster;

/**
 * A broadcaster that remembers what the application would have published to Reverb: the whole pipeline (domain event, listener,
 * broadcast event, `BroadcastEvent` job) runs for real and ends here, so tests assert the channel names, event names and payloads
 * exactly as they would go over the wire. `failWith()` makes every publish throw, like a Reverb that is down.
 */
final class RecordingBroadcaster extends Broadcaster
{
    /** @var list<array{channels: list<string>, event: string, payload: array<string, mixed>}> */
    public array $published = [];

    private ?\Throwable $failure = null;

    public function failWith(?\Throwable $failure): void
    {
        $this->failure = $failure;
    }

    public function auth($request): never
    {
        throw new \LogicException('Not used: channel authorisation tests run against the real Pusher broadcaster.');
    }

    public function validAuthenticationResponse($request, $result): never
    {
        throw new \LogicException('Not used.');
    }

    public function broadcast(array $channels, $event, array $payload = []): void
    {
        if ($this->failure !== null) {
            throw $this->failure;
        }

        unset($payload['socket']);

        // What the Pusher client serialises: the JSON the browser receives, objects and enums included.
        /** @var array<string, mixed> $wire */
        $wire = json_decode(json_encode($payload, JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);

        $this->published[] = ['channels' => $this->formatChannels($channels), 'event' => $event, 'payload' => $wire];
    }

    /**
     * What was published under this event name.
     *
     * @return list<array{channels: list<string>, event: string, payload: array<string, mixed>}>
     */
    public function of(string $event): array
    {
        return array_values(array_filter($this->published, fn (array $entry): bool => $entry['event'] === $event));
    }

    /** The channels of the single publish of this event (fails when there are none or several). */
    public function sole(string $event): array
    {
        $entries = $this->of($event);

        if (count($entries) !== 1) {
            throw new \LogicException("Expected exactly one [{$event}] publish, found ".count($entries).'.');
        }

        return $entries[0];
    }

    /**
     * Every channel the event went to, over all publishes.
     *
     * @return list<string>
     */
    public function channelsOf(string $event): array
    {
        $channels = [];

        foreach ($this->of($event) as $entry) {
            array_push($channels, ...$entry['channels']);
        }

        sort($channels);

        return $channels;
    }

    public function reset(): void
    {
        $this->published = [];
    }
}
