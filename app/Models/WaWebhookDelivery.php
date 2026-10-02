<?php

namespace App\Models;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use Database\Factories\WaWebhookDeliveryFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * The idempotency ledger of the OpenWA webhook: one row per accepted delivery, unique per `(session_id, idempotency_key)`. NULL
 * `outcome` = accepted and waiting for the queue; the job completes it. Never exposed to a client.
 *
 * @property int $id
 * @property int $session_id
 * @property string $idempotency_key
 * @property string|null $delivery_id
 * @property string $event
 * @property WebhookOutcome|null $outcome
 * @property Carbon $received_at
 * @property Carbon|null $processed_at
 * @property string|null $error
 * @property-read WhatsAppSession $session
 */
#[Fillable(['session_id', 'idempotency_key', 'delivery_id', 'event', 'outcome', 'received_at', 'processed_at', 'error'])]
class WaWebhookDelivery extends Model
{
    /** @use HasFactory<WaWebhookDeliveryFactory> */
    use HasFactory;

    public $timestamps = false;

    /** The column holds 255 characters: a longer key (OpenWA derives it from ids) is stored as `sha256:<hex>`, deterministically. */
    private const MAX_KEY_LENGTH = 255;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'session_id' => 'integer',
            'outcome' => WebhookOutcome::class,
            'received_at' => 'datetime',
            'processed_at' => 'datetime',
        ];
    }

    /**
     * The value to store and look up for an `X-OpenWA-Idempotency-Key`.
     */
    public static function keyFor(string $idempotencyKey): string
    {
        return strlen($idempotencyKey) <= self::MAX_KEY_LENGTH ? $idempotencyKey : 'sha256:'.hash('sha256', $idempotencyKey);
    }

    /**
     * @return BelongsTo<WhatsAppSession, $this>
     */
    public function session(): BelongsTo
    {
        return $this->belongsTo(WhatsAppSession::class, 'session_id')->withTrashed();
    }

    /** Written by the job once it has dealt with the delivery. */
    public function isProcessed(): bool
    {
        return $this->processed_at !== null;
    }
}
