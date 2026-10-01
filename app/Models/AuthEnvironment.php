<?php

namespace App\Models;

use App\Auth\Pizzasys\PizzasysEndpoint;
use Database\Factories\AuthEnvironmentFactory;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use SensitiveParameter;

/**
 * One configured pizzasys deployment (`production` or `testing`).
 *
 * The service token and the NATS token are stored encrypted only; they are exposed through the virtual
 * `service_token` / `nats_token` attributes (decrypt on read, encrypt on write) and are never serialised.
 *
 * @property int $id
 * @property string $key
 * @property string $label
 * @property string $base_url
 * @property string $api_prefix
 * @property string $service_name
 * @property string $service_token_encrypted
 * @property string|null $nats_url
 * @property string|null $nats_token_encrypted
 * @property string $nats_stream
 * @property bool $verify_tls
 * @property Carbon|null $last_check_at
 * @property string|null $last_check_status
 * @property string|null $last_check_message
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property string|null $service_token Decrypted service token (virtual).
 * @property string|null $nats_token Decrypted NATS token (virtual).
 */
#[Fillable([
    'key', 'label', 'base_url', 'api_prefix', 'service_name', 'service_token', 'nats_url', 'nats_token', 'nats_stream',
    'verify_tls', 'last_check_at', 'last_check_status', 'last_check_message',
])]
#[Hidden(['service_token_encrypted', 'nats_token_encrypted'])]
class AuthEnvironment extends Model
{
    /** @use HasFactory<AuthEnvironmentFactory> */
    use HasFactory;

    public const PRODUCTION = 'production';

    public const TESTING = 'testing';

    /** @var list<string> */
    public const KEYS = [self::PRODUCTION, self::TESTING];

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'api_prefix' => '/api/v1',
        'nats_stream' => 'AUTH_EVENTS',
        'verify_tls' => true,
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'verify_tls' => 'boolean',
            'last_check_at' => 'datetime',
        ];
    }

    /**
     * @return HasMany<UserExternalIdentity, $this>
     */
    public function identities(): HasMany
    {
        return $this->hasMany(UserExternalIdentity::class);
    }

    /**
     * @return HasMany<ExternalSession, $this>
     */
    public function sessions(): HasMany
    {
        return $this->hasMany(ExternalSession::class);
    }

    /**
     * @return Attribute<string|null, string|null>
     */
    protected function serviceToken(): Attribute
    {
        return Attribute::make(
            get: fn (mixed $value, array $attributes): ?string => self::decrypt($attributes['service_token_encrypted'] ?? null),
            set: fn (#[SensitiveParameter] ?string $value): array => ['service_token_encrypted' => $value === null ? null : Crypt::encryptString($value)],
        );
    }

    /**
     * @return Attribute<string|null, string|null>
     */
    protected function natsToken(): Attribute
    {
        return Attribute::make(
            get: fn (mixed $value, array $attributes): ?string => self::decrypt($attributes['nats_token_encrypted'] ?? null),
            set: fn (#[SensitiveParameter] ?string $value): array => ['nats_token_encrypted' => $value === null || $value === '' ? null : Crypt::encryptString($value)],
        );
    }

    public function hasServiceToken(): bool
    {
        return $this->service_token_encrypted !== '';
    }

    public function hasNatsToken(): bool
    {
        return $this->nats_token_encrypted !== null && $this->nats_token_encrypted !== '';
    }

    /** The decrypted connection details, or null when the stored token cannot be decrypted (rotated APP_KEY). */
    public function endpoint(): ?PizzasysEndpoint
    {
        $token = $this->service_token;

        if ($token === null || $token === '') {
            return null;
        }

        return new PizzasysEndpoint($this->key, $this->base_url, $this->api_prefix, $this->service_name, $token, $this->verify_tls);
    }

    private static function decrypt(?string $payload): ?string
    {
        if ($payload === null || $payload === '') {
            return null;
        }

        try {
            return Crypt::decryptString($payload);
        } catch (DecryptException) {
            return null;
        }
    }
}
