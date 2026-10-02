<?php

namespace App\Models;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\PhoneNumber;
use App\Domain\Widgets\Support\AppOrigin;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use SensitiveParameter;

/**
 * A WhatsApp number linked through the self-hosted OpenWA gateway. `ulid` is the id the dashboard and the webhook URL use,
 * `openwa_session_id` the one OpenWA assigned. Status moves follow `SessionStatus` and are written by the WhatsApp actions only.
 * Admin-only: nothing of a session reaches an agent or a visitor (the hand-off response carries just the number).
 *
 * The webhook secret is stored encrypted (`webhook_secret_encrypted`; OpenWA never returns it) and read through the virtual
 * `webhook_secret`; `last_qr` (a PNG data URL, a login credential while it is valid) is encrypted by its cast. Neither is serialised.
 * `settings` may override the pacing settings per session (`send_min_interval_ms`, `daily_send_cap`).
 *
 * @property int $id
 * @property string $ulid
 * @property int|null $workspace_id
 * @property string $name
 * @property string|null $openwa_session_id
 * @property string|null $openwa_webhook_id
 * @property string $engine
 * @property SessionStatus $status
 * @property string|null $phone_e164
 * @property string|null $push_name
 * @property string|null $webhook_secret_encrypted
 * @property Carbon|null $webhook_registered_at
 * @property string|null $last_qr
 * @property Carbon|null $last_qr_at
 * @property Carbon|null $ready_at
 * @property int|null $last_event_ms Epoch milliseconds of the newest session event applied (from the signed envelope)
 * @property string|null $last_error
 * @property array<string, mixed>|null $settings
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property Carbon|null $deleted_at
 * @property string|null $webhook_secret Decrypted webhook secret (virtual).
 * @property-read int|null $widgets_count
 */
#[Fillable([
    'workspace_id', 'name', 'openwa_session_id', 'openwa_webhook_id', 'engine', 'status', 'phone_e164', 'push_name', 'webhook_secret',
    'webhook_registered_at', 'last_qr', 'last_qr_at', 'ready_at', 'last_error', 'settings',
])]
#[Hidden(['webhook_secret_encrypted', 'last_qr'])]
class WhatsAppSession extends Model
{
    /** @use HasFactory<WhatsAppSessionFactory> */
    use HasFactory, HasUlids, SoftDeletes;

    /** OpenWA session names: letters, digits and hyphens, 3 to 50 characters (and unique among live sessions). */
    public const NAME_PATTERN = '/^[A-Za-z0-9-]{3,50}$/';

    protected $table = 'whatsapp_sessions';

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'engine' => 'whatsapp-web.js',
        'status' => 'created',
    ];

    /**
     * `ulid` is a public id next to the integer primary key, not the primary key itself.
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
            'workspace_id' => 'integer',
            'status' => SessionStatus::class,
            'webhook_registered_at' => 'datetime',
            'last_qr' => 'encrypted',
            'last_qr_at' => 'datetime',
            'ready_at' => 'datetime',
            'last_event_ms' => 'integer',
            'settings' => 'array',
        ];
    }

    /**
     * Widgets that hand visitors over to this number.
     *
     * @return HasMany<Widget, $this>
     */
    public function widgets(): HasMany
    {
        return $this->hasMany(Widget::class, 'whatsapp_session_id');
    }

    /**
     * @return HasMany<WaChat, $this>
     */
    public function chats(): HasMany
    {
        return $this->hasMany(WaChat::class, 'session_id');
    }

    /**
     * @return HasMany<WaHandoffTicket, $this>
     */
    public function handoffTickets(): HasMany
    {
        return $this->hasMany(WaHandoffTicket::class, 'session_id');
    }

    /**
     * @return HasMany<WaWebhookDelivery, $this>
     */
    public function webhookDeliveries(): HasMany
    {
        return $this->hasMany(WaWebhookDelivery::class, 'session_id');
    }

    /**
     * The decrypted webhook secret (null when none was generated yet, or the app key changed since).
     *
     * @return Attribute<string|null, string|null>
     */
    protected function webhookSecret(): Attribute
    {
        return Attribute::make(
            get: fn (mixed $value, array $attributes): ?string => self::decrypt($attributes['webhook_secret_encrypted'] ?? null),
            set: fn (#[SensitiveParameter] ?string $value): array => ['webhook_secret_encrypted' => $value === null || $value === '' ? null : Crypt::encryptString($value)],
        );
    }

    public function hasWebhookSecret(): bool
    {
        return $this->webhook_secret_encrypted !== null && $this->webhook_secret_encrypted !== '';
    }

    /** Connected to a phone (`ready`): messages can be sent and the hand-off number may be offered. */
    public function isUsable(): bool
    {
        return $this->status->isUsable();
    }

    public function canTransitionTo(SessionStatus $to): bool
    {
        return $this->status->canTransitionTo($to);
    }

    /** A QR is waiting to be scanned (the image itself is read with `last_qr`, never serialised). */
    public function hasQr(): bool
    {
        return $this->status === SessionStatus::Qr && $this->last_qr !== null && $this->last_qr !== '';
    }

    public function isWebhookRegistered(): bool
    {
        return $this->webhook_registered_at !== null;
    }

    /**
     * Where OpenWA delivers this session's events: the configured app origin (never the host of the current request) plus
     * `/webhooks/openwa/{ulid}`, the route of the webhook controller (6A, `routes/webhooks/whatsapp.php`).
     */
    public function webhookUrl(): string
    {
        return rtrim(app(AppOrigin::class)->url(), '/').'/webhooks/openwa/'.$this->ulid;
    }

    /** The connected number for display (`+62•••••7890`); null before the session has connected. */
    public function maskedPhone(): ?string
    {
        return PhoneNumber::mask($this->phone_e164);
    }

    /** The shortest pause between two sends: the session's override, else the `whatsapp.send_min_interval_ms` setting. */
    public function sendMinIntervalMs(): int
    {
        return $this->pacingOverride('send_min_interval_ms') ?? settings()->int('whatsapp.send_min_interval_ms', 1500);
    }

    /** Messages one UTC day: the session's override, else the `whatsapp.daily_send_cap` setting. */
    public function dailySendCap(): int
    {
        return $this->pacingOverride('daily_send_cap') ?? settings()->int('whatsapp.daily_send_cap', 200);
    }

    private function pacingOverride(string $key): ?int
    {
        $value = $this->settings[$key] ?? null;

        return is_int($value) || (is_string($value) && ctype_digit($value)) ? max(0, (int) $value) : null;
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
