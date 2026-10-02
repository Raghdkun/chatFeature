<?php

namespace App\Models;

use App\Domain\Notifications\Enums\PromptState;
use Database\Factories\NotificationSettingFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A staff member's notification preferences and the state of the first-login dialog (P5-D4, P5-D7). One row per user, created the
 * first time anything is saved; a user without a row has the defaults and has never been asked.
 *
 * `quiet_hours` is `{enabled, start, end, timezone}` (`HH:MM` wall-clock times in an IANA timezone; start after end = overnight).
 *
 * @property int $id
 * @property int $user_id
 * @property bool $sound
 * @property bool $push_offers
 * @property bool $push_messages
 * @property bool $include_preview
 * @property array{enabled?: bool, start?: string, end?: string, timezone?: string}|null $quiet_hours
 * @property PromptState $prompt_state
 * @property Carbon|null $prompted_at
 * @property Carbon|null $snoozed_until
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read User $user
 */
#[Fillable(['user_id', 'sound', 'push_offers', 'push_messages', 'include_preview', 'quiet_hours', 'prompt_state', 'prompted_at', 'snoozed_until'])]
class NotificationSetting extends Model
{
    /** @use HasFactory<NotificationSettingFactory> */
    use HasFactory;

    /**
     * Mirrors the column defaults so a model that is not saved yet reads like a stored one.
     *
     * @var array<string, mixed>
     */
    protected $attributes = [
        'sound' => true,
        'push_offers' => true,
        'push_messages' => true,
        'include_preview' => true,
        'prompt_state' => 'never',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'user_id' => 'integer',
            'sound' => 'boolean',
            'push_offers' => 'boolean',
            'push_messages' => 'boolean',
            'include_preview' => 'boolean',
            'quiet_hours' => 'array',
            'prompt_state' => PromptState::class,
            'prompted_at' => 'datetime',
            'snoozed_until' => 'datetime',
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
