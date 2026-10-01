<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Config\ConfigMirror;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;

/**
 * Publishes the draft: it becomes the visitor-facing config, `config_version` goes up by one, the operational
 * columns follow the mirrored config fields, and every cache of the widget (boot config, availability) is busted.
 */
final class PublishWidget
{
    public function __construct(
        private readonly WidgetConfigValidator $configs,
        private readonly WidgetCache $cache,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(Widget $widget, ?User $actor = null): Widget
    {
        $published = DB::transaction(function () use ($widget, $actor): Widget {
            /** @var Widget $locked */
            $locked = Widget::query()->lockForUpdate()->findOrFail($widget->getKey());

            $config = $this->configs->hydrate($locked->draft_config);
            $from = $locked->config_version;

            $locked->forceFill([
                ...ConfigMirror::columnsFrom($config),
                'config' => $config->toArray(),
                'draft_config' => $config->toArray(),
                'config_version' => $from + 1,
            ])->save();

            $this->audit->record('widget.published', $locked, ['config_version' => ['from' => $from, 'to' => $from + 1]], $actor);

            return $locked;
        });

        $this->cache->bust($published);

        return $published->refresh();
    }
}
