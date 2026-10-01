<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\Widget;

/**
 * Soft-deletes a widget: its public endpoints answer 404 from now on; the row (and its key) stays for history.
 */
final class DeleteWidget
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly WidgetCache $cache,
    ) {}

    public function handle(Widget $widget, ?User $actor = null): void
    {
        $widget->delete();
        $this->cache->bust($widget);
        $this->audit->record('widget.deleted', $widget, ['name' => $widget->name, 'public_key' => $widget->public_key], $actor);
    }
}
