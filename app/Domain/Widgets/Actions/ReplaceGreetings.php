<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetGreeting;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Replaces a widget's greeting pool: entries with a known ULID are updated in place, entries without one are
 * created, and everything not mentioned is removed.
 */
final class ReplaceGreetings
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly WidgetCache $cache,
    ) {}

    /**
     * @param  list<array{ulid?: string|null, body: string, agent_name?: string|null, agent_avatar_url?: string|null, locale?: string|null, weight: int, is_active: bool, sort_order: int}>  $items  validated
     * @return Collection<int, WidgetGreeting>
     */
    public function handle(Widget $widget, array $items, ?User $actor = null): Collection
    {
        DB::transaction(function () use ($widget, $items): void {
            $existing = $widget->greetings()->get()->keyBy('ulid');
            $keep = [];

            foreach ($items as $item) {
                $attributes = [
                    'body' => $item['body'],
                    'agent_name' => $item['agent_name'] ?? null,
                    'agent_avatar_url' => $item['agent_avatar_url'] ?? null,
                    'locale' => $item['locale'] ?? null,
                    'weight' => $item['weight'],
                    'is_active' => $item['is_active'],
                    'sort_order' => $item['sort_order'],
                ];

                $ulid = $item['ulid'] ?? null;
                $greeting = is_string($ulid) ? $existing->get($ulid) : null;

                if ($greeting instanceof WidgetGreeting) {
                    $greeting->update($attributes);
                } else {
                    $greeting = $widget->greetings()->create($attributes);
                }

                $keep[] = $greeting->id;
            }

            $widget->greetings()->reorder()->whereNotIn('id', $keep)->delete();
        });

        $this->cache->bust($widget);
        $this->audit->record('widget.greetings_updated', $widget, ['count' => count($items)], $actor);

        return $widget->greetings()->get();
    }
}
