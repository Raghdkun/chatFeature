<?php

namespace App\Domain\Catalog\Support;

use App\Models\Category;
use Illuminate\Support\Str;

/**
 * Slugs of categories: lower-case words joined by hyphens, unique per workspace.
 */
final class CategorySlugger
{
    public const MAX_LENGTH = 64;

    /** Pattern accepted for slugs typed by an admin. */
    public const PATTERN = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/D';

    /**
     * A free slug derived from `$source`, with `-2`, `-3`, ... appended when it is taken.
     */
    public function unique(string $source, ?int $ignoreId = null): string
    {
        $base = Str::limit(Str::slug($source), 56, '');
        $base = trim($base, '-');
        $base = $base === '' ? 'category' : $base;

        $candidate = $base;

        for ($suffix = 2; $this->taken($candidate, $ignoreId); $suffix++) {
            $candidate = $base.'-'.$suffix;
        }

        return $candidate;
    }

    public function taken(string $slug, ?int $ignoreId = null): bool
    {
        return Category::query()
            ->withTrashed()
            ->where('slug', $slug)
            ->when($ignoreId !== null, fn ($query) => $query->whereKeyNot($ignoreId))
            ->exists();
    }
}
