<?php

namespace App\Models;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\WhatsApp\Support\WaChatSearch;
use Database\Factories\WaChatFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One WhatsApp conversation partner (a person, or a group) of one session, recorded for the admin inbox. `chat_id` is the WhatsApp id
 * as OpenWA reports it (`4915...@c.us`, a privacy id `...@lid`, a group `...@g.us`), unique per session. Linked to a widget, visitor
 * and category when a hand-off ticket matched (`WaHandoffTicket`); an unmatched chat is recorded all the same.
 * Admin-only: neither agents nor visitors ever see a `wa_chat`.
 *
 * @property int $id
 * @property string $ulid
 * @property int|null $workspace_id
 * @property int $session_id
 * @property string $chat_id
 * @property string|null $phone_e164
 * @property string|null $push_name
 * @property bool $is_group
 * @property WaChatStatus $status
 * @property int|null $widget_id
 * @property int|null $visitor_id
 * @property int|null $category_id
 * @property int|null $handoff_ticket_id
 * @property Carbon|null $last_inbound_at
 * @property Carbon|null $last_message_at
 * @property string|null $last_message_preview
 * @property int $unread_by_admin
 * @property bool $inbound_initiated
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read WhatsAppSession $session
 * @property-read Widget|null $widget
 * @property-read Visitor|null $visitor
 * @property-read Category|null $category
 * @property-read WaHandoffTicket|null $handoffTicket
 */
#[Fillable([
    'workspace_id', 'session_id', 'chat_id', 'phone_e164', 'push_name', 'is_group', 'status', 'widget_id', 'visitor_id', 'category_id',
    'handoff_ticket_id', 'last_inbound_at', 'last_message_at', 'last_message_preview', 'unread_by_admin', 'inbound_initiated',
])]
class WaChat extends Model
{
    /** @use HasFactory<WaChatFactory> */
    use HasFactory, HasUlids;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'is_group' => false,
        'status' => 'open',
        'unread_by_admin' => 0,
        'inbound_initiated' => false,
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
            'session_id' => 'integer',
            'is_group' => 'boolean',
            'status' => WaChatStatus::class,
            'widget_id' => 'integer',
            'visitor_id' => 'integer',
            'category_id' => 'integer',
            'handoff_ticket_id' => 'integer',
            'last_inbound_at' => 'datetime',
            'last_message_at' => 'datetime',
            'unread_by_admin' => 'integer',
            'inbound_initiated' => 'boolean',
        ];
    }

    /**
     * @return BelongsTo<WhatsAppSession, $this>
     */
    public function session(): BelongsTo
    {
        return $this->belongsTo(WhatsAppSession::class, 'session_id')->withTrashed();
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
     * The ticket whose code linked this chat.
     *
     * @return BelongsTo<WaHandoffTicket, $this>
     */
    public function handoffTicket(): BelongsTo
    {
        return $this->belongsTo(WaHandoffTicket::class, 'handoff_ticket_id');
    }

    /**
     * The transcript, oldest first.
     *
     * @return HasMany<WaMessage, $this>
     */
    public function messages(): HasMany
    {
        return $this->hasMany(WaMessage::class)->orderBy('id');
    }

    /** Matched to a widget visitor through a hand-off ticket. */
    public function isLinked(): bool
    {
        return $this->widget_id !== null;
    }

    public function isArchived(): bool
    {
        return $this->status === WaChatStatus::Archived;
    }

    /**
     * Chats shown in the inbox (not archived).
     *
     * @param  Builder<WaChat>  $query
     * @return Builder<WaChat>
     */
    public function scopeOpen(Builder $query): Builder
    {
        return $query->where($query->qualifyColumn('status'), WaChatStatus::Open->value);
    }

    /**
     * Chats of one session.
     *
     * @param  Builder<WaChat>  $query
     * @return Builder<WaChat>
     */
    public function scopeForSession(Builder $query, WhatsAppSession|int $session): Builder
    {
        return $query->where($query->qualifyColumn('session_id'), $session instanceof WhatsAppSession ? $session->id : $session);
    }

    /**
     * Chats a hand-off ticket matched to a widget.
     *
     * @param  Builder<WaChat>  $query
     * @return Builder<WaChat>
     */
    public function scopeLinked(Builder $query): Builder
    {
        return $query->whereNotNull($query->qualifyColumn('widget_id'));
    }

    /**
     * The admin search over chats (see {@see WaChatSearch}): number, name, last message, the linked visitor's details and the
     * text of any message of the chat.
     *
     * @param  Builder<WaChat>  $query
     * @return Builder<WaChat>
     */
    public function scopeSearch(Builder $query, string $text): Builder
    {
        (new WaChatSearch)->apply($query, $text);

        return $query;
    }
}
