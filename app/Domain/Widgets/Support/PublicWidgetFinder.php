<?php

namespace App\Domain\Widgets\Support;

use App\Models\Widget;

/**
 * Looks a widget up by its public key for the visitor-facing endpoints. Unknown, soft-deleted and (by default)
 * disabled widgets are indistinguishable: `null`.
 *
 * Keys that do not exist at all are remembered for a short while (WidgetCache::UNKNOWN_KEY_SECONDS): probing with
 * random keys costs one lookup per key, not one per request. The memory is dropped when a widget is created with
 * that key and whenever a widget is busted, so it never hides a widget that exists (disabled / deleted widgets are
 * not remembered: they can come back, and their keys are unguessable anyway).
 */
final class PublicWidgetFinder
{
    /** Route constraint for `{key}` parameters. */
    public const KEY_PATTERN = 'wk_[A-Za-z0-9_-]{6,40}';

    public function __construct(private readonly WidgetCache $cache) {}

    public function find(string $key, bool $includeDisabled = false): ?Widget
    {
        if (preg_match('/^'.self::KEY_PATTERN.'$/D', $key) !== 1) {
            return null;
        }

        if ($this->cache->isUnknownKey($key)) {
            return null;
        }

        $widget = Widget::query()
            ->with('domains')
            ->where('public_key', $key)
            ->when(! $includeDisabled, fn ($query) => $query->where('is_enabled', true))
            ->first();

        if ($widget === null) {
            // Disabled and soft-deleted widgets are still "known": only a key with no row whatsoever is remembered.
            if (! Widget::withTrashed()->where('public_key', $key)->exists()) {
                $this->cache->rememberUnknownKey($key);
            }

            return null;
        }

        // MySQL collations compare case-insensitively; keys are case-sensitive identifiers.
        return hash_equals($widget->public_key, $key) ? $widget : null;
    }
}
