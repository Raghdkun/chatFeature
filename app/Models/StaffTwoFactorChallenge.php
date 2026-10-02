<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A native sign-in that passed the password and waits for the second factor (docs/mobile-readiness.md, "Sign-in"). Identified by the
 * sha256 of a secret only the client holds; bound to one user and one device name; single use and short-lived.
 *
 * @property int $id
 * @property string $token_hash
 * @property int $user_id
 * @property string $device_name
 * @property int $attempts Wrong codes so far.
 * @property Carbon $expires_at
 * @property Carbon|null $consumed_at
 * @property string|null $ip_address
 * @property Carbon|null $created_at
 * @property-read User $user
 */
#[Fillable(['token_hash', 'user_id', 'device_name', 'attempts', 'expires_at', 'consumed_at', 'ip_address'])]
#[Hidden(['token_hash'])]
class StaffTwoFactorChallenge extends Model
{
    public const UPDATED_AT = null;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'attempts' => 'integer',
            'expires_at' => 'datetime',
            'consumed_at' => 'datetime',
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
