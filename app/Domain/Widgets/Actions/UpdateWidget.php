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
 *
 * The row is locked and re-read inside the transaction (as PublishWidget does), and the mirrored fields are overlaid onto
 * THAT copy: the route-bound model may be older than the database, and writing its `config` / `draft_config` back would
 * undo a publish or a draft save that happened in between.
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
        DB::transaction(function () use ($widget, $attributes, $actor): void {
            /** @var Widget $locked */
            $locked = Widget::query()->lockForUpdate()->findOrFail($widget->getKey());
            $locked->fill($attributes);

            if ($locked->isDirty()) {
                $changes = $locked->getDirty();
                // Only what this request changed is mirrored: unpublished draft edits of the other fields stay as they are.
                $mirrored = array_keys(array_intersect_key($changes, ConfigMirror::PATHS));
                $locked->config = ConfigMirror::overlayColumns($locked->config, $locked, $mirrored);
                $locked->draft_config = ConfigMirror::overlayColumns($locked->draft_config, $locked, $mirrored);
                $locked->save();

                $this->audit->record('widget.updated', $locked, collect($changes)->map(fn (mixed $value): mixed => $value instanceof \BackedEnum ? $value->value : $value)->all(), $actor);
            }

            $this->cache->bust($locked);
        });

        return $widget->refresh();
    }
}
