<?php

namespace App\Models;

use Closure;
use Database\Factories\WaHandoffTicketFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use RuntimeException;

/**
 * The short code a visitor sends over WhatsApp so the chat can be linked to the widget, visitor and topic they came from (decision
 * P6-D3). Live until `expires_at` or `consumed_at`; the first inbound message that carries it links the `wa_chat` (`wa_chat_id`).
 * The code is the only thing the visitor ever sees of the ticket.
 *
 * @property int $id
 * @property string $ulid
 * @property int $widget_id
 * @property int|null $visitor_id
 * @property int|null $category_id
 * @property int $session_id
 * @property string|null $network_hash
 * @property string $code
 * @property Carbon $expires_at
 * @property Carbon|null $consumed_at
 * @property int|null $wa_chat_id
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read Widget $widget
 * @property-read Visitor|null $visitor
 * @property-read Category|null $category
 * @property-read WhatsAppSession $session
 * @property-read WaChat|null $chat
 */
#[Fillable(['widget_id', 'visitor_id', 'category_id', 'session_id', 'network_hash', 'code', 'expires_at', 'consumed_at', 'wa_chat_id'])]
class WaHandoffTicket extends Model
{
    /** @use HasFactory<WaHandoffTicketFactory> */
    use HasFactory, HasUlids;

    /** No 0 / O / 1 / I / L: a code is read off a screen and typed (or pasted) into WhatsApp. */
    public const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

    public const CODE_LENGTH = 8;

    /** Attempts at finding a free code: with 31^8 combinations a second attempt is already a rarity. */
    private const GENERATE_ATTEMPTS = 10;

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

    protected static function booted(): void
    {
        // Every ticket gets its code; callers that insert in a race retry on the UNIQUE index.
        static::creating(function (self $ticket): void {
            if (blank($ticket->code)) {
                $ticket->code = self::generateCode();
            }
        });
    }

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'widget_id' => 'integer',
            'visitor_id' => 'integer',
            'category_id' => 'integer',
            'session_id' => 'integer',
            'expires_at' => 'datetime',
            'consumed_at' => 'datetime',
            'wa_chat_id' => 'integer',
        ];
    }

    /**
     * A random code that no ticket (live or not) uses.
     *
     * @param  (Closure(string): bool)|null  $taken  Whether a candidate is already in use; the tickets table when omitted (tests pass their own).
     *
     * @throws RuntimeException when ten random picks all collided (the table would have to be nearly full)
     */
    public static function generateCode(?Closure $taken = null): string
    {
        $taken ??= static fn (string $code): bool => self::query()->where('code', $code)->exists();
        $last = strlen(self::ALPHABET) - 1;

        for ($attempt = 0; $attempt < self::GENERATE_ATTEMPTS; $attempt++) {
            $code = '';

            for ($i = 0; $i < self::CODE_LENGTH; $i++) {
                $code .= self::ALPHABET[random_int(0, $last)];
            }

            if (! $taken($code)) {
                return $code;
            }
        }

        throw new RuntimeException('Could not find a free hand-off code.');
    }

    /**
     * @return BelongsTo<Widget, $this>
     */
    public function widget(): BelongsTo
    {
        return $this->belongsTo(Widget::class)->withTrashed();
    }

    /**
     * @return BelongsTo<Visitor, $this>
     */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /**
     * @return BelongsTo<Category, $this>
     */
    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class)->withTrashed();
    }

    /**
     * @return BelongsTo<WhatsAppSession, $this>
     */
    public function session(): BelongsTo
    {
        return $this->belongsTo(WhatsAppSession::class, 'session_id')->withTrashed();
    }

    /**
     * @return BelongsTo<WaChat, $this>
     */
    public function chat(): BelongsTo
    {
        return $this->belongsTo(WaChat::class, 'wa_chat_id');
    }

    public function isConsumed(): bool
    {
        return $this->consumed_at !== null;
    }

    public function isExpired(): bool
    {
        return $this->expires_at->isPast();
    }

    /** Neither used nor expired: the only tickets a chat may be linked with. */
    public function isLive(): bool
    {
        return ! $this->isConsumed() && ! $this->isExpired();
    }

    /**
     * Tickets that can still link a chat (not consumed, not expired).
     *
     * @param  Builder<WaHandoffTicket>  $query
     * @return Builder<WaHandoffTicket>
     */
    public function scopeLive(Builder $query): Builder
    {
        return $query->whereNull($query->qualifyColumn('consumed_at'))
            ->where($query->qualifyColumn('expires_at'), '>', now());
    }

    /**
     * A code as typed by a person (case and surrounding space do not matter).
     *
     * @param  Builder<WaHandoffTicket>  $query
     * @return Builder<WaHandoffTicket>
     */
    public function scopeWithCode(Builder $query, string $code): Builder
    {
        return $query->where($query->qualifyColumn('code'), strtoupper(trim($code)));
    }
}
