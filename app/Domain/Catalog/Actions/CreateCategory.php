<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Catalog\Support\CategorySlugger;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Creates a category; the slug is generated from the name unless the admin typed one.
 *
 * The slug check and the insert are not atomic: when two requests pick the same generated slug, the loser of the unique
 * index asks the slugger again (it sees the winner's row now) instead of failing; a slug the admin typed that was taken
 * in the meantime answers `409 slug_taken`.
 */
final class CreateCategory
{
    private const SLUG_ATTEMPTS = 5;

    public function __construct(
        private readonly CategorySlugger $slugger,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array<string, mixed>  $attributes  validated: name, slug?, description?, icon?, color?, sort_order?, is_active?, name_i18n?
     *
     * @throws ApiProblemException 409 `slug_taken`
     */
    public function handle(array $attributes, ?User $actor = null): Category
    {
        $typed = is_string($attributes['slug'] ?? null) && $attributes['slug'] !== '' ? $attributes['slug'] : null;

        for ($attempt = 1; ; $attempt++) {
            $category = new Category($attributes);
            $category->slug = $typed ?? $this->slugger->unique((string) $attributes['name']);

            if (! array_key_exists('sort_order', $attributes)) {
                $category->sort_order = (int) Category::query()->max('sort_order') + 1;
            }

            try {
                $category->save();

                break;
            } catch (UniqueConstraintViolationException $exception) {
                if ($typed !== null) {
                    throw ApiProblemException::conflict('slug_taken', __('This slug is already used by another category.'));
                }

                if ($attempt >= self::SLUG_ATTEMPTS) {
                    throw $exception;
                }
            }
        }

        $this->audit->record('category.created', $category, ['slug' => $category->slug, 'name' => $category->name], $actor);

        return $category->refresh();
    }
}
