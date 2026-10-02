<?php

namespace Tests\Support;

use App\Models\Conversation;
use App\Models\ConversationEvent;
use App\Models\Message;
use App\Models\Rating;
use App\Models\WaChat;
use App\Models\WaMessage;
use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;
use Illuminate\Support\Collection;

/**
 * The analytics numbers of one day computed the slow, obvious way: every raw row is loaded through Eloquent and counted in plain PHP
 * loops, with no SQL aggregation and none of the production collectors. The reconciliation tests compare the rollup to this.
 * It repeats the DEFINITIONS of docs/analytics.md, not the implementation.
 */
final class AnalyticsReference
{
    /** @var array<string, array<string, array<string, int>>> */
    private array $rows = [];

    /** @var array<int, array<string, array<string, array<string, int>>>> */
    private array $slots = [];

    /** @var list<array{kind: string, from: int, to: int, agent: int|null, conversation: Conversation}> */
    private array $pending = [];

    private CarbonImmutable $start;

    private CarbonImmutable $end;

    private int $limit;

    private function __construct(string $date, string $timezone, private readonly bool $withWhatsApp)
    {
        $this->start = CarbonImmutable::createFromFormat('!Y-m-d', $date, $timezone)->startOfDay();
        $next = CarbonImmutable::createFromFormat('!Y-m-d', $date, 'UTC')->addDay()->format('Y-m-d');
        $this->end = CarbonImmutable::createFromFormat('!Y-m-d', $next, $timezone)->startOfDay();
        $this->limit = min($this->end->getTimestamp(), now()->getTimestamp());
    }

    /**
     * @return array{rows: array<string, array<string, array<string, int>>>, slots: array<int, array<string, array<string, array<string, int>>>>}
     */
    public static function day(string $date, string $timezone, bool $withWhatsApp = true): array
    {
        $reference = new self($date, $timezone, $withWhatsApp);
        $reference->compute();
        $reference->peaks();

        return ['rows' => $reference->rows, 'slots' => $reference->slots];
    }

    private function compute(): void
    {
        $events = ConversationEvent::query()->orderBy('id')->get()->groupBy('conversation_id');
        $messages = Message::query()->orderBy('id')->get()->groupBy('conversation_id');
        $ratings = Rating::query()->get()->keyBy('conversation_id');
        $this->rows['total'][''] ??= [];

        foreach (Conversation::query()->orderBy('id')->get() as $conversation) {
            $this->conversation($conversation, $events->get($conversation->id, new Collection), $messages->get($conversation->id, new Collection), $ratings->get($conversation->id));
        }

        if ($this->withWhatsApp) {
            $this->whatsApp();
        }
    }

    /**
     * @param  Collection<int, ConversationEvent>  $events
     * @param  Collection<int, Message>  $messages
     */
    private function conversation(Conversation $conversation, Collection $events, Collection $messages, ?Rating $rating): void
    {
        $live = $conversation->type->value === 'live';
        $claims = $events->where('type', 'claimed')->values();
        $firstClaim = $claims->first();
        $lastActor = $claims->isEmpty() ? null : $claims->last()->actor_id;

        if ($this->in($conversation->created_at)) {
            if ($live) {
                $this->count($conversation, 'started');
                $this->slot($conversation->created_at, $conversation, 'started', false);
            } else {
                $this->count($conversation, 'offline_created');
            }
        }

        if ($live) {
            foreach ($claims as $index => $claim) {
                if (! $this->in($claim->created_at)) {
                    continue;
                }

                $this->slot($claim->created_at, $conversation, 'claimed', true, $claim->actor_id);

                if ($index > 0) {
                    $this->count($conversation, 'reclaimed', 1, $claim->actor_id);

                    continue;
                }

                $wait = max(0, $claim->created_at->getTimestamp() - $conversation->created_at->getTimestamp());
                $this->count($conversation, 'handled', 1, $claim->actor_id);
                $this->count($conversation, 'wait_sum_s', $wait, $claim->actor_id);
                $this->count($conversation, 'wait_count', 1, $claim->actor_id);
                $this->maximum($conversation, 'wait_max_s', $wait, $claim->actor_id);
            }

            foreach ($events as $event) {
                if (! $this->in($event->created_at)) {
                    continue;
                }

                if ($event->type === 'missed') {
                    $this->count($conversation, 'missed');
                }

                if ($event->type === 'offered') {
                    foreach ($event->payload['agents'] ?? [] as $agent) {
                        $this->count($conversation, 'offers', 1, (int) $agent);
                    }
                }

                if ($event->type === 'transferred') {
                    $this->count($conversation, 'transferred', 1, $event->payload['from_agent'] ?? null);

                    if (($event->payload['to_agent'] ?? null) !== null) {
                        $this->count($conversation, 'offers', 1, (int) $event->payload['to_agent']);
                    }
                }
            }

            $this->outcomes($conversation, $firstClaim, $lastActor, $messages);
        }

        if ($rating !== null && $this->in($rating->created_at) && $rating->score >= 1 && $rating->score <= 5) {
            $this->count($conversation, 'rating_count', 1, $lastActor);
            $this->count($conversation, 'rating_sum', $rating->score, $lastActor);
            $this->count($conversation, 'rating_'.$rating->score, 1, $lastActor);
        }

        foreach ($messages as $message) {
            if (! $this->in($message->created_at) || ! in_array($message->sender_type->value, ['visitor', 'agent'], true)) {
                continue;
            }

            if ($message->sender_type->value === 'agent') {
                $this->count($conversation, 'messages_agent', 1, $message->sender_user_id);
            } else {
                $this->count($conversation, 'messages_visitor');
            }
        }

        $firstAgent = $messages->first(fn (Message $message): bool => $message->sender_type->value === 'agent');

        if ($firstAgent !== null && $this->in($firstAgent->created_at)) {
            if ($live && $firstClaim !== null) {
                $seconds = max(0, $firstAgent->created_at->getTimestamp() - $firstClaim->created_at->getTimestamp());
                $this->count($conversation, 'frt_sum_s', $seconds, $firstAgent->sender_user_id);
                $this->count($conversation, 'frt_count', 1, $firstAgent->sender_user_id);
                $this->maximum($conversation, 'frt_max_s', $seconds, $firstAgent->sender_user_id);
            }

            if (! $live) {
                $this->count($conversation, 'offline_answered', 1, $firstAgent->sender_user_id);
                $this->count($conversation, 'offline_response_sum_s', max(0, $firstAgent->created_at->getTimestamp() - $conversation->created_at->getTimestamp()), $firstAgent->sender_user_id);
            }
        }

        if (! $live) {
            if ($this->in($conversation->closed_at)) {
                $this->count($conversation, 'offline_closed');
            }

            return;
        }

        $this->sweep($conversation, $events);
    }

    /**
     * @param  Collection<int, Message>  $messages
     */
    private function outcomes(Conversation $conversation, ?ConversationEvent $firstClaim, ?int $lastActor, Collection $messages): void
    {
        if ($this->in($conversation->closed_at)) {
            $reason = in_array($conversation->close_reason?->value, ['rated', 'skipped', 'idle', 'timeout', 'system', 'cancelled'], true) ? $conversation->close_reason->value : 'system';
            $this->count($conversation, 'closed_'.$reason);
        }

        $terminatedAt = null;
        $resolution = null;

        if ($this->in($conversation->ended_at)) {
            $terminatedAt = $conversation->ended_at;
            $resolution = match ($conversation->ended_by?->value) {
                'visitor' => 'res_visitor',
                'agent', 'admin' => 'res_agent',
                default => 'res_system',
            };
            $this->count($conversation, 'ended', 1, $lastActor);
        } elseif ($conversation->ended_at === null && $this->in($conversation->closed_at) && $firstClaim !== null) {
            $terminatedAt = $conversation->closed_at;
            $resolution = $conversation->close_reason?->value === 'idle' ? 'res_idle' : 'res_system';
        }

        if ($terminatedAt === null) {
            return;
        }

        $this->count($conversation, $resolution, 1, $lastActor);
        $this->count($conversation, 'msgs_sum', $messages->filter(fn (Message $message): bool => in_array($message->sender_type->value, ['visitor', 'agent'], true))->count(), $lastActor);
        $this->count($conversation, 'msgs_count', 1, $lastActor);

        if ($firstClaim !== null) {
            $handling = max(0, $terminatedAt->getTimestamp() - $firstClaim->created_at->getTimestamp());
            $this->count($conversation, 'handling_sum_s', $handling, $lastActor);
            $this->count($conversation, 'handling_count', 1, $lastActor);
            $this->maximum($conversation, 'handling_max_s', $handling, $lastActor);
        }
    }

    /**
     * Intervals from the events (a different shape than production: one pass listing "who held the chat when"), then the peak as the most
     * intervals covering any interval start.
     *
     * @param  Collection<int, ConversationEvent>  $events
     */
    private function sweep(Conversation $conversation, Collection $events): void
    {
        // Only chats with an event in the 72 hours before the day (or in it) are looked at (the sweep's look-back).
        $lifecycle = ['created', 'claimed', 'transferred', 'requeued', 'ended', 'closed', 'missed', 'cancelled'];
        $lookedAt = $events->contains(fn (ConversationEvent $event): bool => in_array($event->type, $lifecycle, true)
            && $event->created_at->getTimestamp() >= $this->start->getTimestamp() - 72 * 3600
            && $event->created_at->getTimestamp() < $this->end->getTimestamp());

        if (! $lookedAt) {
            return;
        }

        /** @var list<array{kind: string, from: int, to: int|null, agent: int|null}> $intervals */
        $intervals = [];
        $open = ['queue' => null, 'active' => null];
        $agent = null;

        $close = function (string $kind, int $at) use (&$open, &$intervals, &$agent): void {
            if ($open[$kind] === null) {
                return;
            }

            $intervals[] = ['kind' => $kind, 'from' => $open[$kind], 'to' => $at, 'agent' => $kind === 'active' ? $agent : null];
            $open[$kind] = null;
        };

        foreach ($events as $event) {
            $at = $event->created_at->getTimestamp();

            match ($event->type) {
                'created' => $open['queue'] ??= $at,
                'claimed' => (function () use (&$open, $close, $at, $event, &$agent): void {
                    $close('queue', $at);

                    if ($open['active'] === null) {
                        $open['active'] = $at;
                        $agent = $event->actor_id;
                    }
                })(),
                'transferred', 'requeued' => (function () use (&$open, $close, $at): void {
                    $close('active', $at);
                    $open['queue'] ??= $at;
                })(),
                'ended' => $close('active', $at),
                'closed', 'missed', 'cancelled' => (function () use ($close, $at): void {
                    $close('active', $at);
                    $close('queue', $at);
                })(),
                default => null,
            };
        }

        foreach (['queue', 'active'] as $kind) {
            if ($open[$kind] !== null) {
                $intervals[] = ['kind' => $kind, 'from' => $open[$kind], 'to' => null, 'agent' => $kind === 'active' ? $agent : null];
            }
        }

        foreach ($intervals as $interval) {
            $from = max($interval['from'], $this->start->getTimestamp());
            $rawEnd = $interval['to'] ?? $this->limit;
            $to = min($rawEnd <= $interval['from'] ? $interval['from'] + 1 : $rawEnd, $this->limit);

            if ($to <= $from) {
                continue;
            }

            $this->pending[] = ['kind' => $interval['kind'], 'from' => $from, 'to' => $to, 'agent' => $interval['agent'], 'conversation' => $conversation];
        }
    }

    private function peaks(): void
    {
        $groups = [];

        foreach ($this->pending as $interval) {
            $conversation = $interval['conversation'];
            $targets = [['total', ''], ['widget', (string) $conversation->widget_id], ['category', (string) ($conversation->category_id ?? 0)]];

            if ($interval['kind'] === 'active') {
                $targets[] = ['agent', (string) ($interval['agent'] ?? 0)];
            }

            foreach ($targets as [$dimension, $key]) {
                $groups[$interval['kind']][$dimension][$key][] = [$interval['from'], $interval['to']];
            }
        }

        foreach ($groups as $kind => $dimensions) {
            foreach ($dimensions as $dimension => $keys) {
                foreach ($keys as $key => $intervals) {
                    $peak = 0;

                    foreach ($intervals as [$from]) {
                        $covering = count(array_filter($intervals, static fn (array $other): bool => $other[0] <= $from && $from < $other[1]));
                        $peak = max($peak, $covering);
                    }

                    $this->rows[$dimension][$key][$kind === 'queue' ? 'queue_peak' : 'peak_concurrent'] = $peak;
                }
            }
        }
    }

    private function whatsApp(): void
    {
        $chats = WaChat::query()->get()->filter(fn (WaChat $chat): bool => $this->in($chat->created_at));
        $this->rows['whatsapp'][''] ??= [];
        $this->rows['whatsapp']['']['wa_chats_new'] = $chats->count();
        $this->rows['whatsapp']['']['wa_chats_linked'] = $chats->filter(fn (WaChat $chat): bool => $chat->widget_id !== null)->count();

        $sent = ['sent', 'delivered', 'read'];
        $all = WaMessage::query()->orderBy('wa_chat_id')->orderBy('wa_timestamp')->orderBy('id')->get()->groupBy('wa_chat_id');
        $inbound = 0;
        $outbound = 0;
        $sum = 0;
        $count = 0;

        foreach ($all as $messages) {
            $waiting = null;

            foreach ($messages as $message) {
                $at = $message->wa_timestamp;
                $isOut = $message->direction->value === 'out';
                $counts = ! $isOut || in_array($message->status->value, $sent, true);
                $inDay = $this->in($at);

                if ($inDay && $counts) {
                    $isOut ? $outbound++ : $inbound++;
                }

                if (! $isOut) {
                    if ($at->getTimestamp() >= $this->start->getTimestamp() - 7 * 86400 && $at->lt($this->end)) {
                        $waiting ??= $at;
                    }

                    continue;
                }

                if (! in_array($message->status->value, $sent, true) || $at->getTimestamp() < $this->start->getTimestamp() - 7 * 86400 || $at->gte($this->end)) {
                    continue;
                }

                if ($waiting !== null && $inDay) {
                    $sum += max(0, $at->getTimestamp() - $waiting->getTimestamp());
                    $count++;
                }

                $waiting = null;
            }
        }

        $this->rows['whatsapp']['']['wa_inbound'] = $inbound;
        $this->rows['whatsapp']['']['wa_outbound'] = $outbound;
        $this->rows['whatsapp']['']['wa_response_sum_s'] = $sum;
        $this->rows['whatsapp']['']['wa_response_count'] = $count;
    }

    private function in(?CarbonInterface $moment): bool
    {
        return $moment !== null && $moment->getTimestamp() >= $this->start->getTimestamp() && $moment->getTimestamp() < $this->end->getTimestamp();
    }

    /** Add `$by` to every row the fact belongs to; `$agent` is `false` when the agent dimension does not apply. */
    private function count(Conversation $conversation, string $column, int $by = 1, int|false|null $agent = false): void
    {
        foreach ($this->targets($conversation, $agent) as [$dimension, $key]) {
            $this->rows[$dimension][$key][$column] = ($this->rows[$dimension][$key][$column] ?? 0) + $by;
        }
    }

    private function maximum(Conversation $conversation, string $column, int $value, int|false|null $agent = false): void
    {
        foreach ($this->targets($conversation, $agent) as [$dimension, $key]) {
            $this->rows[$dimension][$key][$column] = max($this->rows[$dimension][$key][$column] ?? 0, $value);
        }
    }

    private function slot(CarbonInterface $at, Conversation $conversation, string $column, bool $withAgent, ?int $agent = null): void
    {
        $slot = intdiv($at->getTimestamp(), 900) * 900;

        foreach ($this->targets($conversation, $withAgent ? $agent : false) as [$dimension, $key]) {
            $this->slots[$slot][$dimension][$key][$column] = ($this->slots[$slot][$dimension][$key][$column] ?? 0) + 1;
        }
    }

    /**
     * @return list<array{0: string, 1: string}>
     */
    private function targets(Conversation $conversation, int|false|null $agent): array
    {
        $targets = [['total', ''], ['widget', (string) $conversation->widget_id], ['category', (string) ($conversation->category_id ?? 0)]];

        if ($agent !== false) {
            $targets[] = ['agent', (string) ($agent ?? 0)];
        }

        return $targets;
    }
}
