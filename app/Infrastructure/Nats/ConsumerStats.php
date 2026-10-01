<?php

namespace App\Infrastructure\Nats;

/**
 * Counters of one consumer run (also printed by the command on exit).
 */
final class ConsumerStats
{
    /** Deliveries seen, whatever their outcome. */
    public int $received = 0;

    /** Events whose handler changed state (flush/deactivate). */
    public int $handled = 0;

    /** Known events that needed no action. */
    public int $noops = 0;

    /** Replays of an already-processed envelope id (acked and skipped). */
    public int $duplicates = 0;

    /** Events with a type no route knows (acked, kept in processed_events with outcome "unknown"). */
    public int $unknown = 0;

    /** Handler failures (the message was nak'd or dead-lettered). */
    public int $failed = 0;

    /** Messages given up on after the maximum number of deliveries. */
    public int $deadLettered = 0;

    /** Bodies that are not a valid CloudEvent (terminated, never retried). */
    public int $malformed = 0;

    /** Failed connection/session attempts that led to a reconnect. */
    public int $reconnects = 0;

    /**
     * @return array<string, int>
     */
    public function toArray(): array
    {
        return get_object_vars($this);
    }
}
