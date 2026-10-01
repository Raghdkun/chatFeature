<?php

namespace App\Domain\Widgets\Support;

use App\Models\Widget;
use Illuminate\Contracts\Cache\Repository;
use Illuminate\Support\Str;

/**
 * Per-widget cache namespace. Every cached artefact of a widget (resolved boot config, availability) is keyed
 * with the widget's current revision token; `bust()` swaps the token, which orphans all of them at once
 * (they simply expire) without needing cache tags.
 */
final class WidgetCache
{
    /** The revision token outlives every artefact it guards (their lifetimes are minutes) without living forever. */
    private const REVISION_SECONDS = 2_592_000;

    public function __construct(private readonly Repository $cache) {}

    public function key(Widget $widget, string $kind, string ...$parts): string
    {
        return implode(':', ['widgets', $widget->ulid, $this->revision($widget), $kind, ...$parts]);
    }

    /**
     * Invalidate everything cached for the widget (publish, settings, domains, greetings, categories).
     */
    public function bust(Widget $widget): void
    {
        $this->cache->put($this->revisionKey($widget), Str::lower(Str::random(10)), self::REVISION_SECONDS);
    }

    public function repository(): Repository
    {
        return $this->cache;
    }

    private function revision(Widget $widget): string
    {
        $revision = $this->cache->get($this->revisionKey($widget));

        if (! is_string($revision) || $revision === '') {
            $revision = Str::lower(Str::random(10));
            $this->cache->put($this->revisionKey($widget), $revision, self::REVISION_SECONDS);
        }

        return $revision;
    }

    private function revisionKey(Widget $widget): string
    {
        return 'widgets:'.$widget->ulid.':rev';
    }
}
