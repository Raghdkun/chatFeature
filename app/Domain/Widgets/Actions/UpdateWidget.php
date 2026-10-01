<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Config\ConfigMirror;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;

/**
 * Updates the operational settings of a widget (name, enabled, locale, timeouts, offline mode, timezone, non-browser access).
 * They apply immediately; the five that are mirrored inside the config object are written into BOTH the published
 * and the draft config so the builder never shows a phantom difference.
 */
final class UpdateWidget
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly WidgetCache $cache,
    ) {}

    /**
     * @param  array<string, mixed>  $attributes  validated: name, is_enabled, locale, idle_timeout_minutes, queue_timeout_seconds, offline_mode, timezone, allow_non_browser_clients
     */
    public function handle(Widget $widget, array $attributes, ?User $actor = null): Widget
    {
        return DB::transaction(function () use ($widget, $attributes, $actor): Widget {
            $widget->fill($attributes);

            if ($widget->isDirty()) {
                $changes = $widget->getDirty();
                // Only what this request changed is mirrored: unpublished draft edits of the other fields stay as they are.
                $mirrored = array_keys(array_intersect_key($changes, ConfigMirror::PATHS));
                $widget->config = ConfigMirror::overlayColumns($widget->config, $widget, $mirrored);
                $widget->draft_config = ConfigMirror::overlayColumns($widget->draft_config, $widget, $mirrored);
                $widget->save();

                $this->audit->record('widget.updated', $widget, collect($changes)->map(fn (mixed $value): mixed => $value instanceof \BackedEnum ? $value->value : $value)->all(), $actor);
            }

            $this->cache->bust($widget);

            return $widget->refresh();
        });
    }
}
