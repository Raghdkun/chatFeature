<?php

namespace App\Models;

use Database\Factories\DeviceTokenFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A mobile device's FCM registration token (P5-D4: a stub for the future mobile app; nothing is sent to it yet). The token is
 * encrypted at rest and never returned by the API.
 *
 * @property int $id
 * @property string $ulid
 * @property int $user_id
 * @property string $platform
 * @property string $token_hash sha256 of the token: the unique key an upsert uses.
 * @property string $token
 * @property Carbon|null $last_seen_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read User $user
 */
#[Fillable(['user_id', 'platform', 'token_hash', 'token', 'last_seen_at'])]
class DeviceToken extends Model
{
    /** @use HasFactory<DeviceTokenFactory> */
    use HasFactory, HasUlids;

    /**
     * @return list<string>
     */
    public function uniqueIds(): array
    {
        return ['ulid'];
    }

    public function getRouteKeyName(): string
    {
        return 'ulid';
    }

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'user_id' => 'integer',
            'token' => 'encrypted',
            'last_seen_at' => 'datetime',
        ];
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @param  Builder<DeviceToken>  $query
     * @return Builder<DeviceToken>
     */
    public function scopeOwnedBy(Builder $query, User|int $user): Builder
    {
        return $query->where($query->qualifyColumn('user_id'), $user instanceof User ? $user->id : $user);
    }
}
