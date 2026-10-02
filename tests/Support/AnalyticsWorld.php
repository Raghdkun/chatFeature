<?php

namespace Tests\Support;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\Visitor;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Writes raw chat rows the way the Chat actions leave them (the conversation row, its audit events, messages and rating), with exact
 * timestamps, so the analytics tests can build any story: `chat()` / `ticket()` return a {@see AnalyticsChat} script whose steps move a
 * clock forward and write what the real action would have written (`ClaimConversation`, `EndConversation`, `RateConversation`, ...).
 *
 * All instants are UTC; the database stores UTC (`config('app.timezone')`).
 */
final class AnalyticsWorld
{
    public function __construct(public Widget $widget, public ?Category $category = null) {}

    /** A live chat created at `$createdAt` (UTC, `Y-m-d H:i:s`). */
    public function chat(string $createdAt, ?Category $category = null, ?Widget $widget = null): AnalyticsChat
    {
        return new AnalyticsChat($this, 'live', $createdAt, $category ?? $this->category, $widget ?? $this->widget);
    }

    /** An offline ticket created at `$createdAt`. */
    public function ticket(string $createdAt, ?Category $category = null, ?Widget $widget = null): AnalyticsChat
    {
        return new AnalyticsChat($this, 'offline', $createdAt, $category ?? $this->category, $widget ?? $this->widget);
    }

    public function visitor(Widget $widget): Visitor
    {
        return Visitor::factory()->create(['widget_id' => $widget->id]);
    }

    public static function at(string $moment): CarbonImmutable
    {
        return CarbonImmutable::parse($moment, 'UTC');
    }

    /**
     * @param  array<string, mixed>|null  $payload
     */
    public static function event(int $conversationId, string $type, string $at, ?string $actorType = null, ?int $actorId = null, ?array $payload = null): void
    {
        DB::table('conversation_events')->insert([
            'conversation_id' => $conversationId,
            'type' => $type,
            'actor_type' => $actorType,
            'actor_id' => $actorId,
            'payload' => $payload === null ? null : json_encode($payload),
            'created_at' => $at,
        ]);
    }
}
