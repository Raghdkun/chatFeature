<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Support\Facades\DB;

/**
 * Replaces the widget's allowed embedding hosts with an already normalised, de-duplicated list.
 */
final class ReplaceDomains
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly WidgetCache $cache,
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
            $widget->domains()->reorder()->whereNotIn('host', $hosts)->delete();
            $existing = $widget->domains()->pluck('host')->all();

            foreach (array_diff($hosts, $existing) as $host) {
                $widget->domains()->save(new WidgetDomain(['host' => $host, 'is_wildcard' => str_starts_with($host, '*.')]));
            }
        });

        $this->cache->bust($widget);
        $this->audit->record('widget.domains_updated', $widget, ['domains' => $hosts], $actor);

        return $hosts;
    }
}
