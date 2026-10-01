<?php

namespace App\Models;

use App\Domain\Chat\Services\MessageText;
use Database\Factories\VisitorFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A person using a widget: anonymous, or verified when the host site vouched for them with a signed identity
 * (`external_id` = the token's `sub`, unique per widget). Written by the Visitors / Chat actions only.
 *
 * @property int $id
 * @property string $ulid
 * @property int|null $workspace_id
 * @property int $widget_id
 * @property string|null $external_id
 * @property bool $verified
 * @property string|null $name
 * @property string|null $email
 * @property string|null $phone
 * @property array<string, mixed>|null $meta
 * @property Carbon|null $first_seen_at
 * @property Carbon|null $last_seen_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read Widget $widget
 */
#[Fillable(['workspace_id', 'widget_id', 'external_id', 'verified', 'name', 'email', 'phone', 'meta', 'first_seen_at', 'last_seen_at'])]
class Visitor extends Model
{
    /** @use HasFactory<VisitorFactory> */
    use HasFactory, HasUlids;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'verified' => false,
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
     * The name is one line of plain text (it is quoted in e-mails and shown to staff): control characters and line breaks are
     * replaced and whitespace collapsed whenever it is set, whichever path sets it.
     *
     * @return Attribute<string|null, string|null>
     */
    protected function name(): Attribute
    {
        return Attribute::set(fn (?string $value): ?string => MessageText::singleLine($value));
    }

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'workspace_id' => 'integer',
            'widget_id' => 'integer',
            'verified' => 'boolean',
            'meta' => 'array',
            'first_seen_at' => 'datetime',
            'last_seen_at' => 'datetime',
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
     * @return HasMany<VisitorSession, $this>
     */
    public function sessions(): HasMany
    {
        return $this->hasMany(VisitorSession::class);
    }

    /**
     * @return HasMany<Conversation, $this>
     */
    public function conversations(): HasMany
    {
        return $this->hasMany(Conversation::class);
    }
}
