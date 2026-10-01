<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Idempotency ledger of consumed pizzasys events (one row per envelope id, pruned after `nats.retention_days`).
 *
 * @property string $event_id
 * @property string $type
 * @property string $subject
 * @property string $outcome
 * @property Carbon $processed_at
 */
#[Fillable(['event_id', 'type', 'subject', 'outcome', 'processed_at'])]
class ProcessedEvent extends Model
{
    protected $primaryKey = 'event_id';

    protected $keyType = 'string';

    public $incrementing = false;

    public $timestamps = false;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'processed_at' => 'datetime',
        ];
    }

    /**
     * Delete ledger rows older than the given number of days; returns how many were removed.
     */
    public static function pruneOlderThan(int $days): int
    {
        return static::query()->where('processed_at', '<', now()->subDays($days))->delete();
    }
}
