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
 * The DB mirror of a staff member's presence (one row per user). P5 adds the Redis ZSET (source of truth), auto-away and the
 * sweep behind this model; P4 only needs the status. `is_manual` = the agent picked the status themselves.
 *
 * @property int $id
 * @property int $user_id
 * @property PresenceStatus $status
 * @property bool $is_manual
 * @property Carbon|null $last_seen_at
 * @property Carbon|null $last_heartbeat_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read User $user
 */
#[Fillable(['user_id', 'status', 'is_manual', 'last_seen_at', 'last_heartbeat_at'])]
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
