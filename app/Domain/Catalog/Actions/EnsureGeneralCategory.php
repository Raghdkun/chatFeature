<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Install\Contracts\SeedsDefaults;
use App\Domain\Install\InstallContext;
use App\Models\Category;

/**
 * Install seeder: every installation starts with one active "General" category so a first widget can take chats.
 * Idempotent: an existing category with that slug is left untouched.
 */
final class EnsureGeneralCategory implements SeedsDefaults
{
    public const SLUG = 'general';

    public function seed(InstallContext $context): void
    {
        $this->ensure();
    }

    public function ensure(): Category
    {
        $existing = Category::query()->where('slug', self::SLUG)->first();

        if ($existing !== null) {
            return $existing;
        }

        return Category::query()->forceCreate([
            'slug' => self::SLUG,
            'name' => 'General',
            'description' => 'General questions and anything that fits nowhere else.',
            'icon' => 'message-circle',
            'sort_order' => 0,
            'is_active' => true,
        ]);
    }
}
