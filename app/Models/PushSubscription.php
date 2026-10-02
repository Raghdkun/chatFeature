<?php

namespace App\Models;

use Database\Factories\PushSubscriptionFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One browser a staff member enabled web push in (P5-D4). The endpoint is the push service's URL for that browser: it is a secret
 * capability (whoever has it and the keys can push to the browser), so it never appears in an API response, only its host does.
 * `p256dh` and `auth` are the subscription's keys, encrypted at rest.
 *
 * @property int $id
 * @property string $ulid
 * @property int $user_id
 * @property string $endpoint_hash sha256 of the endpoint: the unique key an upsert uses.
 * @property string $endpoint
 * @property string $p256dh
 * @property string $auth
 * @property string $content_encoding
 * @property string|null $user_agent
 * @property string|null $session_hash sha256 of the web session that registered it (null for a bearer-token client).
 * @property Carbon|null $expires_at
 * @property Carbon|null $last_used_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read User $user
 */
#[Fillable(['user_id', 'endpoint_hash', 'endpoint', 'p256dh', 'auth', 'content_encoding', 'user_agent', 'session_hash', 'expires_at', 'last_used_at'])]
class PushSubscription extends Model
{
    /** @use HasFactory<PushSubscriptionFactory> */
    use HasFactory, HasUlids;

    /**
     * `ulid` is the public id next to the integer primary key, not the primary key itself.
     *
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
            'p256dh' => 'encrypted',
            'auth' => 'encrypted',
            'expires_at' => 'datetime',
            'last_used_at' => 'datetime',
        ];
    }

    public static function hashEndpoint(string $endpoint): string
    {
        return hash('sha256', $endpoint);
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @param  Builder<PushSubscription>  $query
     * @return Builder<PushSubscription>
     */
    public function scopeOwnedBy(Builder $query, User|int $user): Builder
    {
        return $query->where($query->qualifyColumn('user_id'), $user instanceof User ? $user->id : $user);
    }

    public static function hashSession(string $sessionId): string
    {
        return hash('sha256', $sessionId);
    }

    /** The host of the push service (`fcm.googleapis.com`): all that is ever shown about the endpoint. */
    public function endpointHost(): string
    {
        return (string) (parse_url($this->endpoint, PHP_URL_HOST) ?: '');
    }
}
