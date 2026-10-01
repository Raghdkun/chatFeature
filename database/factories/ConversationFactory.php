<?php

namespace Database\Factories;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * Default: a live chat that was just queued (90 s to find an agent), for a widget / visitor / session that belong
 * together (see `configure()`). One state per status and type keeps the timestamps consistent with the state machine
 * (`active()`, `ended()`, `closed()`, `missed()`, `offline()`). The ticket number comes from the model.
 *
 * @extends Factory<Conversation>
 */
class ConversationFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $queuedAt = now();

        return [
            'workspace_id' => null,
            'category_id' => null,
            'type' => ConversationType::Live,
            'status' => ConversationStatus::Queued,
            'assigned_agent_id' => null,
            'queued_at' => $queuedAt,
            'queue_expires_at' => $queuedAt->copy()->addSeconds(90),
            'last_activity_at' => $queuedAt,
        ];
    }

    /**
     * `widget_id`, `visitor_id` and `visitor_session_id` are filled in after the model is made, so they always belong together:
     * a given visitor (`for($visitor)` / `visitor_id`) brings its widget, a given widget (`for($widget)`) gets a new visitor, and
     * a session is opened for the visitor unless `visitor_session_id` was passed (pass `null` for a conversation without one).
     */
    public function configure(): static
    {
        return $this->afterMaking(function (Conversation $conversation): void {
            $attributes = $conversation->getAttributes();
            $widgetId = $attributes['widget_id'] ?? null;
            $visitorId = $attributes['visitor_id'] ?? null;

            if ($visitorId === null) {
                $visitor = Visitor::factory()->create($widgetId === null ? [] : ['widget_id' => $widgetId]);
                $visitorId = $visitor->id;
                $widgetId ??= $visitor->widget_id;
            } elseif ($widgetId === null) {
                $widgetId = (int) Visitor::query()->whereKey($visitorId)->value('widget_id');
            }

            $conversation->widget_id = $widgetId;
            $conversation->visitor_id = $visitorId;

            if (! array_key_exists('visitor_session_id', $attributes)) {
                $conversation->visitor_session_id = VisitorSession::factory()->create(['visitor_id' => $visitorId, 'widget_id' => $widgetId])->id;
            }
        });
    }

    public function forCategory(Category $category): static
    {
        return $this->state(fn (): array => ['category_id' => $category->id]);
    }

    /** Being worked on by `$agent` (a new agent when omitted). */
    public function active(?User $agent = null): static
    {
        return $this->state(function () use ($agent): array {
            $claimedAt = now();

            return [
                'status' => ConversationStatus::Active,
                'assigned_agent_id' => $agent->id ?? User::factory(),
                'wave' => 1,
                'claimed_at' => $claimedAt,
                'claim_version' => 1,
                'idle_expires_at' => $claimedAt->copy()->addMinutes(120),
            ];
        });
    }

    /** Ended by `$endedBy`, waiting for the visitor's rating (default window of 10 minutes). */
    public function ended(?User $agent = null, ConversationEndedBy $endedBy = ConversationEndedBy::Agent): static
    {
        return $this->active($agent)->state(function () use ($endedBy): array {
            $endedAt = now();

            return [
                'status' => ConversationStatus::Ended,
                'ended_at' => $endedAt,
                'ended_by' => $endedBy,
                'idle_expires_at' => null,
                'rating_requested' => true,
                'rating_window_expires_at' => $endedAt->copy()->addMinutes(10),
            ];
        });
    }

    /** A finished conversation (ended, then rated / skipped / timed out). */
    public function closed(?User $agent = null, ConversationCloseReason $reason = ConversationCloseReason::Skipped): static
    {
        return $this->ended($agent)->state(fn (): array => [
            'status' => ConversationStatus::Closed,
            'closed_at' => now(),
            'close_reason' => $reason,
            'rating_window_expires_at' => null,
        ]);
    }

    /** Nobody accepted before the queue timeout: terminal. */
    public function missed(): static
    {
        return $this->state(fn (): array => [
            'status' => ConversationStatus::Missed,
            'queued_at' => now()->subSeconds(120),
            'queue_expires_at' => now()->subSeconds(30),
        ]);
    }

    /** An offline ticket waiting for staff (no queue timeout). */
    public function offline(): static
    {
        return $this->state(fn (): array => [
            'type' => ConversationType::Offline,
            'status' => ConversationStatus::Queued,
            'queue_expires_at' => null,
        ]);
    }
}
