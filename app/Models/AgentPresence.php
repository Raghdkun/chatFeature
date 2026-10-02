<?php

namespace App\Models;

use App\Domain\Chat\Enums\PresenceStatus;
use Database\Factories\AgentPresenceFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A staff member's presence row (one per user). With the database store it IS the state; with the Redis store (P5) it is a mirror
 * written when the effective status changes. `status` is what the agent chose (or `online` for an automatic agent), `is_manual` = they
 * pinned it (auto-away never moves a pinned status), `last_visible_at` = the last heartbeat from a visible tab, `effective_status` = the
 * status clients were last told (null: never announced). Nothing outside `App\Domain\Presence` should read these columns to decide what an
 * agent's status is: `PresenceService` / `EffectivePresence` do, from whichever store is active.
 *
 * @property int $id
 * @property int $user_id
 * @property PresenceStatus $status
 * @property bool $is_manual
 * @property Carbon|null $last_seen_at
 * @property Carbon|null $last_heartbeat_at
 * @property Carbon|null $last_visible_at
 * @property PresenceStatus|null $effective_status
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read User $user
 */
#[Fillable(['user_id', 'status', 'is_manual', 'last_seen_at', 'last_heartbeat_at', 'last_visible_at', 'effective_status'])]
class AgentPresence extends Model
{
    /** @use HasFactory<AgentPresenceFactory> */
    use HasFactory;

    protected $table = 'agent_presence';

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'status' => 'offline',
        'is_manual' => false,
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'user_id' => 'integer',
            'status' => PresenceStatus::class,
            'is_manual' => 'boolean',
            'last_seen_at' => 'datetime',
            'last_heartbeat_at' => 'datetime',
            'last_visible_at' => 'datetime',
            'effective_status' => PresenceStatus::class,
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
