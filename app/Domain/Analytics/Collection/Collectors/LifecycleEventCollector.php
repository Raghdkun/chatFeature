<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use Illuminate\Support\Facades\DB;

/**
 * Three events that only the audit trail records, counted on the day they happened:
 *  - `missed` (the queue timeout ran out): a live chat nobody accepted;
 *  - `offered`: one offer per agent named in the event (`offers`, in that agent's row);
 *  - `transferred` (an agent or an admin handed the chat on): `transferred` in the row of the agent who let go, and one `offers` for the
 *    colleague it was handed to (a transfer to a topic is offered through the waves, which record their own `offered` events).
 * The offers table itself is not read: the routing code deletes a chat's offers when it is re-queued, the events are never deleted.
 */
final class LifecycleEventCollector implements MetricCollector
{
    public function collect(DayContext $context): void
    {
        $window = $context->window;

        DB::table('conversation_events as e')
            ->join('conversations as c', 'c.id', '=', 'e.conversation_id')
            ->whereIn('e.type', ['missed', 'offered', 'transferred'])
            ->where('c.type', 'live')
            ->where('e.created_at', '>=', $window->startDb())
            ->where('e.created_at', '<', $window->endDb())
            ->orderBy('e.id')
            ->select(['e.id as event_id', 'e.type', 'e.actor_id', 'e.payload', 'c.widget_id', 'c.category_id'])
            ->chunkById(2000, function ($rows) use ($context): void {
                foreach ($rows as $row) {
                    $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id);
                    $payload = is_string($row->payload) ? json_decode($row->payload, true) : null;
                    $payload = is_array($payload) ? $payload : [];

                    match ($row->type) {
                        'missed' => $context->metrics->add($to, 'missed'),
                        'offered' => $this->offered($context, $to, $payload),
                        default => $this->transferred($context, $to, $payload),
                    };
                }
            }, 'e.id', 'event_id');
    }

    /**
     * @param  array<mixed>  $payload
     */
    private function offered(DayContext $context, Attribution $to, array $payload): void
    {
        $agents = $payload['agents'] ?? [];

        foreach (is_array($agents) ? $agents : [] as $agent) {
            if (is_int($agent) || (is_string($agent) && ctype_digit($agent))) {
                $context->metrics->add($to->byAgent((int) $agent), 'offers');
            }
        }
    }

    /**
     * @param  array<mixed>  $payload
     */
    private function transferred(DayContext $context, Attribution $to, array $payload): void
    {
        $from = $this->id($payload['from_agent'] ?? null);
        $toAgent = $this->id($payload['to_agent'] ?? null);

        $context->metrics->add($to->byAgent($from), 'transferred');

        if ($toAgent !== null) {
            $context->metrics->add($to->byAgent($toAgent), 'offers');
        }
    }

    private function id(mixed $value): ?int
    {
        return is_int($value) || (is_string($value) && ctype_digit($value)) ? (int) $value : null;
    }
}
