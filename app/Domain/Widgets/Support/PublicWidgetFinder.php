<?php

namespace App\Domain\Widgets\Support;

use App\Models\Widget;

/**
 * Looks a widget up by its public key for the visitor-facing endpoints. Unknown, soft-deleted and (by default)
 * disabled widgets are indistinguishable: `null`.
 */
final class PublicWidgetFinder
{
    /** Route constraint for `{key}` parameters. */
    public const KEY_PATTERN = 'wk_[A-Za-z0-9_-]{6,40}';

    public function find(string $key, bool $includeDisabled = false): ?Widget
    {
        if (preg_match('/^'.self::KEY_PATTERN.'$/D', $key) !== 1) {
            return null;
        }

        $widget = Widget::query()
            ->with('domains')
            ->where('public_key', $key)
            ->when(! $includeDisabled, fn ($query) => $query->where('is_enabled', true))
            ->first();

        // MySQL collations compare case-insensitively; keys are case-sensitive identifiers.
        return $widget !== null && hash_equals($widget->public_key, $key) ? $widget : null;
    }
}
