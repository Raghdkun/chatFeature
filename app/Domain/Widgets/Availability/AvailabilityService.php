<?php

namespace App\Domain\Widgets\Availability;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Services\RoutingPlan;
use App\Domain\WhatsApp\Support\PhoneNumber;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Domain\Widgets\Contracts\PresenceReader;
use App\Domain\Widgets\Data\AvailabilityData;
use App\Domain\Widgets\Data\CategoryAvailabilityData;
use App\Domain\Widgets\Data\WhatsappAvailabilityData;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\Widget;
use Carbon\CarbonImmutable;

/**
 * Whether a widget can take chats right now: opening hours of the PUBLISHED config (in the widget's timezone,
 * DST-aware) combined with agent presence (counting only the statuses its routing waves can offer a chat to). Cached per widget for a few seconds and dropped on publish / settings changes.
 */
final class AvailabilityService
{
    /** Cache lifetime in seconds (contract: 5 to 10 s). */
    public const CACHE_SECONDS = 8;

    public function __construct(
        private readonly PresenceReader $presence,
        private readonly WidgetCache $cache,
        private readonly WidgetConfigValidator $configs,
    ) {}

    public function forWidget(Widget $widget): AvailabilityData
    {
        return AvailabilityData::from($this->arrayFor($widget));
    }

    /**
     * The cached answer as a plain array (the hot path of the public endpoints: no object hydration).
     *
     * @return array<string, mixed>
     */
    public function arrayFor(Widget $widget): array
    {
        $key = $this->cache->key($widget, 'availability');
        $cached = $this->cache->repository()->get($key);

        if (is_array($cached)) {
            return $cached;
        }

        $availability = $this->compute($widget, CarbonImmutable::now())->toArray();
        $this->cache->repository()->put($key, $availability, self::CACHE_SECONDS);

        return $availability;
    }

    /**
     * Drop the cached answer of one widget (its agents' presence changed; the next request recomputes it).
     */
    public function forget(Widget $widget): void
    {
        $this->cache->repository()->forget($this->cache->key($widget, 'availability'));
    }

    /**
     * Whether the widget's published opening hours say it is open at `$now` (agents not considered).
     */
    public function isOpenAt(Widget $widget, CarbonImmutable $now): bool
    {
        return OpeningHours::fromConfig($this->configs->hydrate($widget->config)->hours, $widget->offline_mode, $widget->timezone)->isOpen($now);
    }

    /**
     * Uncached computation at a given instant (used by tests and by `forWidget`).
     */
    public function compute(Widget $widget, CarbonImmutable $now): AvailabilityData
    {
        $hours = OpeningHours::fromConfig($this->configs->hydrate($widget->config)->hours, $widget->offline_mode, $widget->timezone);
        $openNow = $hours->isOpen($now);

        $categories = $widget->categories()->where('categories.is_active', true)->get();
        // Only agents the widget's routing waves can offer a chat to count: the same rule `StartConversation` applies, so `online` here
        // never promises a chat that `POST /public/conversations` then refuses with `no_agents`.
        $statuses = array_map(static fn (PresenceStatus $status): string => $status->value, RoutingPlan::forWidget($widget)->allStatuses());
        $counts = $this->presence->onlineAgentsByCategory(array_values($categories->map(fn (Category $category): int => $category->id)->all()), $statuses);

        $perCategory = $categories
            ->map(fn (Category $category): CategoryAvailabilityData => new CategoryAvailabilityData(
                slug: $category->slug,
                online: $openNow && ($counts[$category->id] ?? 0) > 0,
            ))
            ->values()
            ->all();

        $next = $openNow ? null : $hours->nextOpening($now);

        return new AvailabilityData(
            online: collect($perCategory)->contains(fn (CategoryAvailabilityData $category): bool => $category->online),
            openNow: $openNow,
            nextOpenAt: $next?->utc()->format('Y-m-d\TH:i:s.v\Z'),
            categories: $perCategory,
            whatsapp: new WhatsappAvailabilityData(enabled: $this->offersWhatsApp($widget)),
        );
    }

    /**
     * Whether visitors may be offered the WhatsApp channel: the global switch (`whatsapp.enabled`), the widget's PUBLISHED `features.whatsapp`
     * and a `ready` session with a number linked to the widget (a deleted session counts as none). Nothing else about the session or its
     * number is public: the number appears only inside the `waUrl` of a hand-off.
     */
    private function offersWhatsApp(Widget $widget): bool
    {
        if (! settings()->bool('whatsapp.enabled', false) || ! $this->configs->hydrate($widget->config)->features->whatsapp) {
            return false;
        }

        $session = $widget->whatsappSession;

        return $session !== null && $session->isUsable() && PhoneNumber::digits($session->phone_e164) !== null;
    }
}
