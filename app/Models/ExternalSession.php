<?php

namespace App\Models;

use Database\Factories\ExternalSessionFactory;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;

/**
 * One signed-in dashboard session (or mobile token) of a portal user, holding the upstream user token
 * (encrypted, server side only). Revoking a session wipes the token.
 *
 * @property string $id
 * @property int $user_id
 * @property int $identity_id
 * @property int $auth_environment_id
 * @property string|null $laravel_session_id
 * @property int|null $sanctum_token_id
 * @property string|null $token_encrypted
 * @property Carbon $last_verified_at
 * @property int $verify_fail_count
 * @property Carbon|null $revoked_at
 * @property string|null $revoked_reason
 * @property string|null $ip
 * @property string|null $user_agent
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property string|null $token Decrypted upstream user token (virtual).
 * @property-read User $user
 * @property-read UserExternalIdentity $identity
 * @property-read AuthEnvironment $environment
 */
#[Fillable([
    'user_id', 'identity_id', 'auth_environment_id', 'laravel_session_id', 'sanctum_token_id', 'token', 'last_verified_at',
    'verify_fail_count', 'revoked_at', 'revoked_reason', 'ip', 'user_agent',
])]
#[Hidden(['token_encrypted'])]
class ExternalSession extends Model
{
    /** @use HasFactory<ExternalSessionFactory> */
    use HasFactory, HasUlids;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'verify_fail_count' => 0,
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'last_verified_at' => 'datetime',
            'verify_fail_count' => 'integer',
            'sanctum_token_id' => 'integer',
            'revoked_at' => 'datetime',
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
     * @return BelongsTo<UserExternalIdentity, $this>
     */
    public function identity(): BelongsTo
    {
        return $this->belongsTo(UserExternalIdentity::class, 'identity_id');
    }

    /**
     * @return BelongsTo<AuthEnvironment, $this>
     */
    public function environment(): BelongsTo
    {
        return $this->belongsTo(AuthEnvironment::class, 'auth_environment_id');
    }

    /**
     * @return Attribute<string|null, string|null>
     */
    protected function token(): Attribute
    {
        return Attribute::make(
            get: function (mixed $value, array $attributes): ?string {
                $payload = $attributes['token_encrypted'] ?? null;

                if (! is_string($payload) || $payload === '') {
                    return null;
                }

                try {
                    return Crypt::decryptString($payload);
                } catch (DecryptException) {
                    return null;
                }
            },
            set: fn (?string $value): array => ['token_encrypted' => $value === null ? null : Crypt::encryptString($value)],
        );
    }

    public function isRevoked(): bool
    {
        return $this->revoked_at !== null;
    }
}
