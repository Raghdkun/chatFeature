<?php

namespace App\Models;

use Database\Factories\WidgetDomainFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One allowed embedding host of a widget, already normalised (`example.com`, `*.example.com`, `localhost:3000`).
 *
 * @property int $id
 * @property int $widget_id
 * @property string $host
 * @property bool $is_wildcard
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
#[Fillable(['host', 'is_wildcard'])]
class WidgetDomain extends Model
{
    /** @use HasFactory<WidgetDomainFactory> */
    use HasFactory;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'widget_id' => 'integer',
            'is_wildcard' => 'boolean',
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
