<?php

namespace App\Models;

use Database\Factories\WidgetGreetingFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One message of a widget's greeting pool (plain text, rendered as text by every client).
 *
 * @property int $id
 * @property string $ulid
 * @property int $widget_id
 * @property string $body
 * @property string|null $agent_name
 * @property string|null $agent_avatar_url
 * @property string|null $locale
 * @property int $weight
 * @property bool $is_active
 * @property int $sort_order
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
#[Fillable(['body', 'agent_name', 'agent_avatar_url', 'locale', 'weight', 'is_active', 'sort_order'])]
class WidgetGreeting extends Model
{
    /** @use HasFactory<WidgetGreetingFactory> */
    use HasFactory, HasUlids;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'weight' => 1,
        'is_active' => true,
        'sort_order' => 0,
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
            'widget_id' => 'integer',
            'weight' => 'integer',
            'is_active' => 'boolean',
            'sort_order' => 'integer',
        ];
    }

    /**
     * @return BelongsTo<Widget, $this>
     */
    public function widget(): BelongsTo
    {
        return $this->belongsTo(Widget::class);
    }
}
