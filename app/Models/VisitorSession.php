<?php

namespace App\Models;

use Database\Factories\VisitorSessionFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One browser's authenticated session with a widget. The bearer token (`vt_...`) is shown once; only its sha256 is
 * stored (`token_hash`). A session belongs to one visitor and creates at most one open conversation.
 * Create and look up sessions through `App\Domain\Visitors\VisitorTokenService`.
 *
 * @property int $id
 * @property string $ulid
 * @property int $visitor_id
 * @property int $widget_id
 * @property string $token_hash
 * @property Carbon $expires_at
 * @property Carbon|null $revoked_at
 * @property Carbon|null $last_used_at
 * @property Carbon|null $socket_authorized_at first time this token was handed a signed websocket subscription (null: never)
 * @property Carbon|null $sockets_cut_at when its websockets were last closed (null: not since the last authorisation)
 * @property string|null $page_url
 * @property string|null $page_title
 * @property string|null $referrer
 * @property string|null $user_agent
 * @property string|null $locale
 * @property string|null $network_hash
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read Visitor $visitor
 * @property-read Widget $widget
 */
#[Fillable(['visitor_id', 'widget_id', 'token_hash', 'expires_at', 'revoked_at', 'last_used_at', 'page_url', 'page_title', 'referrer', 'user_agent', 'locale', 'network_hash'])]
#[Hidden(['token_hash'])]
class VisitorSession extends Model
{
    /** @use HasFactory<VisitorSessionFactory> */
    use HasFactory, HasUlids;

    /**
     * `ulid` is a public id next to the integer primary key, not the primary key itself.
     *
     * @return list<string>
     */
    public function uniqueIds(): array
    {
        return ['ulid'];
    }

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'visitor_id' => 'integer',
            'widget_id' => 'integer',
            'expires_at' => 'datetime',
            'revoked_at' => 'datetime',
            'last_used_at' => 'datetime',
            'socket_authorized_at' => 'datetime',
            'sockets_cut_at' => 'datetime',
        ];
    }

    /**
     * @return BelongsTo<Visitor, $this>
     */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /**
     * @return BelongsTo<Widget, $this>
     */
    public function widget(): BelongsTo
    {
        return $this->belongsTo(Widget::class)->withTrashed();
    }

    /**
     * @return HasMany<Conversation, $this>
     */
    public function conversations(): HasMany
    {
        return $this->hasMany(Conversation::class);
    }

    public function isRevoked(): bool
    {
        return $this->revoked_at !== null;
    }

    public function isExpired(): bool
    {
        return $this->expires_at->isPast();
    }

    /** Neither revoked nor expired: the token may be used. */
    public function isActive(): bool
    {
        return ! $this->isRevoked() && ! $this->isExpired();
    }

    /**
     * Whether this session may act on the conversation: it created it (and the visitor matches). A visitor holding another
     * session's conversation id is a stranger: callers answer `404`, never `403`.
     */
    public function owns(Conversation $conversation): bool
    {
        return $conversation->visitor_session_id === $this->id && $conversation->visitor_id === $this->visitor_id;
    }

    /**
     * @param  Builder<VisitorSession>  $query
     * @return Builder<VisitorSession>
     */
    public function scopeActive(Builder $query): Builder
    {
        return $query->whereNull('revoked_at')->where('expires_at', '>', now());
    }
}
