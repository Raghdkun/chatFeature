<?php

namespace Tests\Support;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * One chat or ticket as a script. Each step moves the clock `$after` seconds and records what the production action records:
 *
 *   $world->chat('2026-03-10 09:00:00')->offeredTo([$a, $b])->claimedBy($a, 40)->agentSays(15, 'hi')->visitorSays(20)->endedBy('visitor', 300)->rated(5, 60)->save();
 *
 * Nothing is written until `save()`, which inserts the conversation row first (its columns follow the steps: status, claimed_at, ended_at,
 * closed_at, ...), then the events and messages with their exact times.
 */
final class AnalyticsChat
{
    private CarbonImmutable $clock;

    /** @var array<string, mixed> */
    private array $columns = [];

    /** @var list<array{type: string, at: string, actor_type: string|null, actor: int|null, payload: array<string, mixed>|null}> */
    private array $events = [];

    /** @var list<array{sender: string, user: int|null, at: string, body: string|null}> */
    private array $messages = [];

    private ?int $score = null;

    private ?string $ratedAt = null;

    private ?User $agent = null;

    public function __construct(
        private readonly AnalyticsWorld $world,
        private readonly string $type,
        string $createdAt,
        private ?Category $category,
        private readonly Widget $widget,
    ) {
        $this->clock = CarbonImmutable::parse($createdAt, 'UTC');
        $this->columns = [
            'type' => $type,
            'status' => 'queued',
            'created_at' => $createdAt,
            'updated_at' => $createdAt,
            'queued_at' => $createdAt,
            'last_activity_at' => $createdAt,
            'queue_expires_at' => $type === 'live' ? $this->clock->addSeconds(90)->format('Y-m-d H:i:s') : null,
        ];
        $this->events[] = $this->makeEvent('created', 'visitor', null, ['category' => $category?->slug, 'widget' => $widget->ulid]);
    }

    /**
     * @param  list<User>  $agents
     */
    public function offeredTo(array $agents, int $wave = 1): self
    {
        $this->events[] = $this->makeEvent('offered', 'system', null, ['wave' => $wave, 'agents' => array_map(static fn (User $agent): int => $agent->id, $agents)]);

        return $this;
    }

    public function visitorSays(int $after = 0, string $body = 'Hello'): self
    {
        $this->tick($after);
        $this->messages[] = ['sender' => 'visitor', 'user' => null, 'at' => $this->now(), 'body' => $body];

        return $this;
    }

    public function claimedBy(User $agent, int $after = 0): self
    {
        $this->tick($after);
        $this->agent = $agent;
        $this->columns['status'] = 'active';
        $this->columns['assigned_agent_id'] = $agent->id;
        $this->columns['claimed_at'] = $this->now();
        $this->columns['queued_at'] ??= null;
        $this->columns['claim_version'] = ((int) ($this->columns['claim_version'] ?? 0)) + 1;
        $this->events[] = $this->makeEvent('claimed', 'agent', $agent->id, ['wave' => 1]);

        if ($this->type === 'live') {
            $this->messages[] = ['sender' => 'system', 'user' => null, 'at' => $this->now(), 'body' => $agent->name.' joined the chat.'];
        }

        return $this;
    }

    public function agentSays(int $after = 0, string $body = 'Hi there', ?User $as = null): self
    {
        $this->tick($after);
        $author = $as ?? $this->agent;
        $this->messages[] = ['sender' => 'agent', 'user' => $author?->id, 'at' => $this->now(), 'body' => $body];

        return $this;
    }

    /** A transfer to a colleague and/or a topic: the chat is queued again and its assignee cleared. */
    public function transferredTo(?User $to, ?Category $category = null, int $after = 0, string $by = 'agent'): self
    {
        $this->tick($after);
        $from = $this->agent?->id;
        $this->events[] = $this->makeEvent('transferred', $by, $from, ['from_agent' => $from, 'to_agent' => $to?->id, 'to_category' => $category?->ulid]);

        $this->columns['status'] = 'queued';
        $this->columns['assigned_agent_id'] = null;
        $this->columns['claimed_at'] = null;
        $this->columns['queued_at'] = $this->now();
        $this->agent = null;

        if ($category !== null) {
            $this->category = $category;
        }

        return $this;
    }

    /** The system puts an active chat back in the queue (its agent was deactivated). */
    public function requeued(int $after = 0): self
    {
        $this->tick($after);
        $this->events[] = $this->makeEvent('requeued', 'system', null, ['from_agent' => $this->agent?->id, 'reason' => 'deactivated']);
        $this->columns['status'] = 'queued';
        $this->columns['assigned_agent_id'] = null;
        $this->columns['claimed_at'] = null;
        $this->columns['queued_at'] = $this->now();
        $this->agent = null;

        return $this;
    }

    public function endedBy(string $by, int $after = 0): self
    {
        $this->tick($after);
        $this->columns['status'] = 'ended';
        $this->columns['ended_at'] = $this->now();
        $this->columns['ended_by'] = $by;
        $this->columns['rating_requested'] = true;
        $this->events[] = $this->makeEvent('ended', $by === 'system' ? 'system' : $by, $by === 'agent' ? $this->agent?->id : null, ['by' => $by]);

        return $this;
    }

    public function rated(int $score, int $after = 0, ?string $comment = null): self
    {
        $this->tick($after);
        $this->score = $score;
        $this->ratedAt = $this->now();
        $this->columns['status'] = 'closed';
        $this->columns['close_reason'] = 'rated';
        $this->columns['closed_at'] = $this->now();
        $this->events[] = $this->makeEvent('rated', 'visitor', null, ['score' => $score]);

        return $this;
    }

    /** `skipped`, `timeout` (after an end), `idle` (an active chat nobody wrote in), `system` (staff closed it), `cancelled` (queued). */
    public function closed(string $reason, int $after = 0, ?string $actorType = 'system', ?int $actorId = null): self
    {
        $this->tick($after);
        $this->columns['status'] = 'closed';
        $this->columns['close_reason'] = $reason;
        $this->columns['closed_at'] = $this->now();
        $this->events[] = $this->makeEvent($reason === 'cancelled' ? 'cancelled' : 'closed', $actorType, $actorId, $reason === 'cancelled' ? null : ['reason' => $reason]);

        return $this;
    }

    public function missed(int $after = 90): self
    {
        $this->tick($after);
        $this->columns['status'] = 'missed';
        $this->events[] = $this->makeEvent('missed', 'system', null, null);

        return $this;
    }

    public function save(): Conversation
    {
        $visitor = $this->world->visitor($this->widget);
        $row = $this->columns + [
            'widget_id' => $this->widget->id,
            'visitor_id' => $visitor->id,
            'visitor_session_id' => null,
            'category_id' => $this->category?->id,
        ];
        $conversation = Conversation::factory()->create($row);

        foreach ($this->events as $event) {
            AnalyticsWorld::event($conversation->id, $event['type'], $event['at'], $event['actor_type'], $event['actor'], $event['payload']);
        }

        $seq = 0;

        foreach ($this->messages as $message) {
            DB::table('messages')->insert([
                'ulid' => (string) Str::ulid(),
                'conversation_id' => $conversation->id,
                'seq' => ++$seq,
                'sender_type' => $message['sender'],
                'sender_user_id' => $message['user'],
                'type' => $message['sender'] === 'system' ? 'system' : 'text',
                'body' => $message['body'],
                'created_at' => $message['at'],
            ]);
        }

        DB::table('conversations')->where('id', $conversation->id)->update(['last_seq' => $seq]);

        if ($this->score !== null) {
            DB::table('ratings')->insert(['conversation_id' => $conversation->id, 'score' => $this->score, 'comment' => null, 'created_at' => $this->ratedAt]);
        }

        return $conversation->refresh();
    }

    private function tick(int $seconds): void
    {
        $this->clock = $this->clock->addSeconds($seconds);
        $this->columns['updated_at'] = $this->now();
    }

    private function now(): string
    {
        return $this->clock->format('Y-m-d H:i:s');
    }

    /**
     * @param  array<string, mixed>|null  $payload
     * @return array{type: string, at: string, actor_type: string|null, actor: int|null, payload: array<string, mixed>|null}
     */
    private function makeEvent(string $type, ?string $actorType, ?int $actor, ?array $payload): array
    {
        return ['type' => $type, 'at' => $this->now(), 'actor_type' => $actorType, 'actor' => $actor, 'payload' => $payload];
    }
}
