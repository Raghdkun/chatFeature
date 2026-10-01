<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Support\Facades\DB;

/**
 * Replaces the widget's allowed embedding hosts with an already normalised, de-duplicated list.
 *
 * Runs under a lock on the widget row and writes with an upsert, so two submissions of the same list (a double click)
 * queue up instead of racing each other into the `(widget_id, host)` unique index.
 */
final class ReplaceDomains
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly WidgetCache $cache,
        private readonly OriginMatcher $origins,
    ) {}

    /**
     * @param  list<string>  $hosts  normalised by OriginMatcher::normalizeEntry()
     * @return list<string> the stored hosts, sorted
     */
    public function handle(Widget $widget, array $hosts, ?User $actor = null): array
    {
        $hosts = array_values(array_unique($hosts));
        sort($hosts);

        DB::transaction(function () use ($widget, $hosts): void {
            Widget::query()->lockForUpdate()->findOrFail($widget->getKey());

            $widget->domains()->reorder()->whereNotIn('host', $hosts)->delete();

            if ($hosts !== []) {
                WidgetDomain::query()->upsert(
                    array_map(fn (string $host): array => [
                        'widget_id' => $widget->getKey(),
                        'host' => $host,
                        'is_wildcard' => $this->origins->isWildcardEntry($host),
                    ], $hosts),
                    ['widget_id', 'host'],
                    ['is_wildcard'],
                );
            }
        });

        $this->cache->bust($widget);
        $this->audit->record('widget.domains_updated', $widget, ['domains' => $hosts], $actor);

        return $hosts;
    }
}
