<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Install\Contracts\SeedsDefaults;
use App\Domain\Install\InstallContext;
use App\Models\Category;
use Illuminate\Database\UniqueConstraintViolationException;

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

        try {
            return Category::query()->forceCreate([
                'slug' => self::SLUG,
                'name' => 'General',
                'description' => 'General questions and anything that fits nowhere else.',
                'icon' => 'message-circle',
                'sort_order' => 0,
                'is_active' => true,
            ]);
        } catch (UniqueConstraintViolationException $exception) {
            // Another process seeded it between the check and the insert: that one is the category.
            return Category::query()->where('slug', self::SLUG)->first() ?? throw $exception;
        }
    }
}
