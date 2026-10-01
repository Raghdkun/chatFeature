<?php

namespace App\Models;

use Database\Factories\UserExternalIdentityFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A local user's account in an auth-portal environment (`external_id` is the pizzasys `sub`).
 * `roles` / `permissions` are the portal's names as of the last verification; the application itself
 * only ever reads `users.is_admin` / `users.is_agent`.
 *
 * @property int $id
 * @property int $user_id
 * @property int $auth_environment_id
 * @property string $external_id
 * @property list<string> $roles
 * @property list<string> $permissions
 * @property bool $active
 * @property Carbon|null $last_verified_at
 * @property Carbon|null $stale_at
 * @property Carbon|null $deactivated_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read User $user
 * @property-read AuthEnvironment $environment
 */
#[Fillable(['user_id', 'auth_environment_id', 'external_id', 'roles', 'permissions', 'active', 'last_verified_at', 'stale_at', 'deactivated_at'])]
class UserExternalIdentity extends Model
{
    /** @use HasFactory<UserExternalIdentityFactory> */
    use HasFactory;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'roles' => '[]',
        'permissions' => '[]',
        'active' => true,
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'roles' => 'array',
            'permissions' => 'array',
            'active' => 'boolean',
            'last_verified_at' => 'datetime',
            'stale_at' => 'datetime',
            'deactivated_at' => 'datetime',
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return BelongsTo<AuthEnvironment, $this>
     */
    public function environment(): BelongsTo
    {
        return $this->belongsTo(AuthEnvironment::class, 'auth_environment_id');
    }

    /**
     * @return HasMany<ExternalSession, $this>
     */
    public function sessions(): HasMany
    {
        return $this->hasMany(ExternalSession::class, 'identity_id');
    }

    public function isDeactivated(): bool
    {
        return $this->deactivated_at !== null;
    }
}
