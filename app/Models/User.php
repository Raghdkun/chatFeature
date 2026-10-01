<?php

namespace App\Models;

use App\Auth\Enums\UserRole;
use Database\Factories\UserFactory;
use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Laravel\Fortify\Contracts\PasskeyUser;
use Laravel\Fortify\PasskeyAuthenticatable;
use Laravel\Fortify\TwoFactorAuthenticatable;
use Laravel\Sanctum\HasApiTokens;

/**
 * Staff member (admin and/or agent). Visitors are a separate model.
 *
 * `is_admin` / `is_agent` are the only role flags the application reads (docs/contracts/auth-driver.md);
 * they are never mass assignable.
 *
 * @property int $id
 * @property int|null $workspace_id
 * @property string $name
 * @property string $email
 * @property Carbon|null $email_verified_at
 * @property string|null $password Null for users that exist only in an external auth portal.
 * @property string|null $two_factor_secret
 * @property string|null $two_factor_recovery_codes
 * @property Carbon|null $two_factor_confirmed_at
 * @property string|null $remember_token
 * @property UserRole $role
 * @property bool $is_admin
 * @property bool $is_agent
 * @property bool $is_active
 * @property string|null $display_name
 * @property string|null $avatar_path
 * @property string|null $locale
 * @property string|null $timezone
 * @property int $max_concurrent_chats
 * @property Carbon|null $last_seen_at
 * @property string $auth_source
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read string $label
 * @property-read string|null $avatar_url
 */
#[Fillable(['name', 'email', 'password', 'display_name', 'locale', 'timezone'])]
#[Hidden(['password', 'two_factor_secret', 'two_factor_recovery_codes', 'remember_token'])]
class User extends Authenticatable implements MustVerifyEmail, PasskeyUser
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable, PasskeyAuthenticatable, TwoFactorAuthenticatable;

    /**
     * Mirrors the column defaults so a freshly created model is consistent before it is re-read.
     *
     * @var array<string, mixed>
     */
    protected $attributes = [
        'role' => 'agent',
        'is_admin' => false,
        'is_agent' => false,
        'is_active' => true,
        'max_concurrent_chats' => 5,
        'auth_source' => 'local',
    ];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'two_factor_confirmed_at' => 'datetime',
            'workspace_id' => 'integer',
            'role' => UserRole::class,
            'is_admin' => 'boolean',
            'is_agent' => 'boolean',
            'is_active' => 'boolean',
            'max_concurrent_chats' => 'integer',
            'last_seen_at' => 'datetime',
        ];
    }

    /** Whether the user may use the chat dashboard at all (admin and/or agent). */
    protected static function booted(): void
    {
        // A deactivated user, or one who lost every chat role, must not keep working with an issued API token.
        static::updated(function (self $user): void {
            if ($user->wasChanged(['is_active', 'is_admin', 'is_agent']) && (! $user->is_active || ! $user->hasChatAccess())) {
                $user->tokens()->delete();
            }
        });
    }

    public function hasChatAccess(): bool
    {
        return $this->is_admin || $this->is_agent;
    }

    /**
     * Name shown to visitors and colleagues: the display name when set, else the account name.
     *
     * @return Attribute<string, never>
     */
    protected function label(): Attribute
    {
        return Attribute::get(fn (): string => ($this->display_name !== null && $this->display_name !== '') ? $this->display_name : $this->name);
    }

    /**
     * Public URL of the uploaded avatar, if any.
     *
     * @return Attribute<string|null, never>
     */
    protected function avatarUrl(): Attribute
    {
        return Attribute::get(fn (): ?string => $this->avatar_path !== null && $this->avatar_path !== ''
            ? Storage::disk('public')->url($this->avatar_path)
            : null);
    }
}
