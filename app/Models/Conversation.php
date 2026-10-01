<?php

namespace App\Models;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Support\TicketNumberGenerator;
use Database\Factories\ConversationFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Carbon;

/**
 * A live chat or an offline ticket. `ulid` is the public id, `ticket_no` the human code. Status moves follow
 * `ConversationStatus::allowedTransitions()` through guarded `UPDATE ... WHERE status = :from` statements written by the
 * Chat actions (never by mass assignment from a request). Visitors never see integer keys, `assigned_agent_id` or counters.
 *
 * @property int $id
 * @property string $ulid
 * @property int|null $workspace_id
 * @property int $widget_id
 * @property int $visitor_id
 * @property int|null $visitor_session_id
 * @property int|null $category_id
 * @property string $ticket_no
 * @property ConversationType $type
 * @property ConversationStatus $status
 * @property int|null $assigned_agent_id
 * @property int $last_seq
 * @property int $claim_version
 * @property int $wave
 * @property Carbon|null $queued_at
 * @property Carbon|null $queue_expires_at
 * @property Carbon|null $claimed_at
 * @property Carbon|null $ended_at
 * @property Carbon|null $closed_at
 * @property ConversationEndedBy|null $ended_by
 * @property ConversationCloseReason|null $close_reason
 * @property Carbon|null $last_activity_at
 * @property Carbon|null $idle_expires_at
 * @property Carbon|null $last_message_at
 * @property string|null $last_message_preview
 * @property int $unseen_by_agent
 * @property int $unseen_by_visitor
 * @property bool $rating_requested
 * @property Carbon|null $rating_window_expires_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read Widget $widget
 * @property-read Visitor $visitor
 * @property-read VisitorSession|null $visitorSession
 * @property-read Category|null $category
 * @property-read User|null $assignedAgent
 * @property-read Rating|null $rating
 */
#[Fillable([
    'workspace_id', 'widget_id', 'visitor_id', 'visitor_session_id', 'category_id', 'ticket_no', 'type', 'status', 'assigned_agent_id',
    'last_seq', 'claim_version', 'wave', 'queued_at', 'queue_expires_at', 'claimed_at', 'ended_at', 'closed_at', 'ended_by', 'close_reason',
    'last_activity_at', 'idle_expires_at', 'last_message_at', 'last_message_preview', 'unseen_by_agent', 'unseen_by_visitor',
    'rating_requested', 'rating_window_expires_at',
])]
class Conversation extends Model
{
    /** @use HasFactory<ConversationFactory> */
    use HasFactory, HasUlids;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'type' => 'live',
        'status' => 'queued',
        'last_seq' => 0,
        'claim_version' => 0,
        'wave' => 0,
        'unseen_by_agent' => 0,
        'unseen_by_visitor' => 0,
        'rating_requested' => false,
    ];

    protected static function booted(): void
    {
        // Every conversation gets its human code; callers that insert in a race retry on the UNIQUE index.
        static::creating(function (self $conversation): void {
            if (blank($conversation->ticket_no)) {
                $conversation->ticket_no = TicketNumberGenerator::unique();
            }
        });
    }

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
     * @return array<string, mixed>
     */
    protected function casts(): array
    {
        return [
            'workspace_id' => 'integer',
            'widget_id' => 'integer',
            'visitor_id' => 'integer',
            'visitor_session_id' => 'integer',
            'category_id' => 'integer',
            'type' => ConversationType::class,
            'status' => ConversationStatus::class,
            'assigned_agent_id' => 'integer',
            'last_seq' => 'integer',
            'claim_version' => 'integer',
            'wave' => 'integer',
            'queued_at' => 'datetime',
            'queue_expires_at' => 'datetime',
            'claimed_at' => 'datetime',
            'ended_at' => 'datetime',
            'closed_at' => 'datetime',
            'ended_by' => ConversationEndedBy::class,
            'close_reason' => ConversationCloseReason::class,
            'last_activity_at' => 'datetime',
            'idle_expires_at' => 'datetime',
            'last_message_at' => 'datetime',
            'unseen_by_agent' => 'integer',
            'unseen_by_visitor' => 'integer',
            'rating_requested' => 'boolean',
            'rating_window_expires_at' => 'datetime',
        ];
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
     * @return BelongsTo<VisitorSession, $this>
     */
    public function visitorSession(): BelongsTo
    {
        return $this->belongsTo(VisitorSession::class);
    }

    /**
     * @return BelongsTo<Category, $this>
     */
    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class)->withTrashed();
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function assignedAgent(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assigned_agent_id');
    }

    /**
     * @return HasMany<Message, $this>
     */
    public function messages(): HasMany
    {
        return $this->hasMany(Message::class)->orderBy('seq');
    }

    /**
     * @return HasMany<ConversationEvent, $this>
     */
    public function events(): HasMany
    {
        return $this->hasMany(ConversationEvent::class)->orderBy('id');
    }

    /**
     * @return HasMany<ConversationOffer, $this>
     */
    public function offers(): HasMany
    {
        return $this->hasMany(ConversationOffer::class);
    }

    /**
     * @return HasMany<Attachment, $this>
     */
    public function attachments(): HasMany
    {
        return $this->hasMany(Attachment::class);
    }

    /**
     * @return HasOne<Rating, $this>
     */
    public function rating(): HasOne
    {
        return $this->hasOne(Rating::class);
    }

    public function isLive(): bool
    {
        return $this->type === ConversationType::Live;
    }

    public function isOffline(): bool
    {
        return $this->type === ConversationType::Offline;
    }

    /** Queued or active: the visitor's "open conversation". */
    public function isOpen(): bool
    {
        return $this->status->isOpen();
    }

    /**
     * Whether the state machine allows this conversation to move to `$to`. On top of the status table, offline tickets have no
     * live-chat life: they are never `ended` (nobody to rate) and never `missed` (they already are the fallback).
     */
    public function canTransitionTo(ConversationStatus $to): bool
    {
        if ($this->isOffline() && in_array($to, [ConversationStatus::Ended, ConversationStatus::Missed], true)) {
            return false;
        }

        return $this->status->canTransitionTo($to);
    }

    /**
     * Whether the user holds a pending offer for this conversation (not answered yet, not expired).
     */
    public function isOfferedTo(User $user): bool
    {
        return $this->offers()->where('user_id', $user->id)->open()->exists();
    }

    /**
     * Queued or active conversations.
     *
     * @param  Builder<Conversation>  $query
     * @return Builder<Conversation>
     */
    public function scopeOpen(Builder $query): Builder
    {
        return $query->whereIn($query->qualifyColumn('status'), ConversationStatus::openValues());
    }

    /**
     * What a staff member may see (the same rule as `ConversationPolicy::viewAsStaff()`; a parity test keeps them in step):
     * an active admin sees everything; an active agent sees the chats assigned to them, plus queued chats currently offered
     * to them (an open offer) and queued offline tickets in a category they serve; everybody else sees nothing.
     *
     * @param  Builder<Conversation>  $query
     * @return Builder<Conversation>
     */
    public function scopeVisibleTo(Builder $query, User $user): Builder
    {
        if (! $user->is_active) {
            return $query->whereRaw('1 = 0');
        }

        if ($user->is_admin) {
            return $query;
        }

        if (! $user->is_agent) {
            return $query->whereRaw('1 = 0');
        }

        $assigned = $query->qualifyColumn('assigned_agent_id');
        $status = $query->qualifyColumn('status');
        $type = $query->qualifyColumn('type');
        $category = $query->qualifyColumn('category_id');

        return $query->where(function (Builder $visible) use ($user, $assigned, $status, $type, $category): void {
            $visible->where($assigned, $user->id)
                ->orWhere(function (Builder $queued) use ($user, $status, $type, $category): void {
                    $queued->where($status, ConversationStatus::Queued->value)
                        ->where(function (Builder $reachable) use ($user, $type, $category): void {
                            $reachable->whereHas('offers', fn (Builder $offer) => $offer->where('user_id', $user->id)->open())
                                ->orWhere(function (Builder $ticket) use ($user, $type, $category): void {
                                    // A ticket without a topic (its widget had none) is everybody's: nobody else would ever see it.
                                    $ticket->where($type, ConversationType::Offline->value)
                                        ->where(fn (Builder $topic) => $topic->whereNull($category)
                                            ->orWhereIn($category, fn ($served) => $served->select('category_id')->from('category_user')->where('user_id', $user->id)));
                                });
                        });
                });
        });
    }
}
