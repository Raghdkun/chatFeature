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
use App\Models\Widget;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * Default: a live chat that was just queued (90 s to find an agent), for a fresh widget / visitor / session that belong
 * together. One state per status and type keeps the timestamps consistent with the state machine
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
            'widget_id' => Widget::factory(),
            'visitor_id' => fn (array $attributes): int => Visitor::factory()->create(['widget_id' => $attributes['widget_id']])->id,
            'visitor_session_id' => fn (array $attributes): int => VisitorSession::factory()->create([
                'visitor_id' => $attributes['visitor_id'],
                'widget_id' => $attributes['widget_id'],
            ])->id,
            'category_id' => null,
            'type' => ConversationType::Live,
            'status' => ConversationStatus::Queued,
            'assigned_agent_id' => null,
            'queued_at' => $queuedAt,
            'queue_expires_at' => $queuedAt->copy()->addSeconds(90),
            'last_activity_at' => $queuedAt,
        ];
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
