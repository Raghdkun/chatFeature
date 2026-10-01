<?php

namespace App\Infrastructure\Nats;

use App\Infrastructure\Nats\Handlers\Handler;
use App\Models\ProcessedEvent;
use Illuminate\Contracts\Container\Container;
use Illuminate\Support\Facades\DB;

/**
 * Applies one CloudEvent exactly once: records its id in `processed_events` (insert-or-ignore) BEFORE dispatching,
 * in the same transaction as the handler's database effects. A duplicate id is skipped; a failing handler rolls the
 * claim back so the redelivery is processed again. The caller acks only after this method returned (= committed).
 */
final class EventProcessor
{
    private ?EventRouter $router = null;

    public function __construct(private readonly Container $container) {}

    /**
     * @throws \Throwable when the handler (or the database) fails; nothing was recorded then
     */
    public function process(CloudEvent $event): EventOutcome
    {
        return DB::transaction(function () use ($event): EventOutcome {
            $key = $event->dedupeKey();

            $claimed = ProcessedEvent::query()->insertOrIgnore([[
                'event_id' => $key,
                'type' => substr($event->type(), 0, 128),
                'subject' => substr($event->subject(), 0, 128),
                'outcome' => 'pending',
                'processed_at' => now(),
            ]]);

            if ($claimed === 0) {
                return EventOutcome::Duplicate;
            }

            $handler = $this->router()->resolve($event);
            $outcome = $handler instanceof Handler ? $handler->handle($event) : EventOutcome::Unknown;

            ProcessedEvent::query()->whereKey($key)->update(['outcome' => $outcome->value]);

            return $outcome;
        }, 3);
    }

    /** Resolved lazily so a process without the pizzasys driver bound can still idle while NATS is off. */
    private function router(): EventRouter
    {
        return $this->router ??= $this->container->make(EventRouter::class);
    }
}
