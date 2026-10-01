<?php

namespace App\Http\Requests\Catalog;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * `{ category_ulids: string[] }`: every entry must name an existing, non-deleted category. Used for
 * `PATCH /agents/{id}/categories` and `PUT /widgets/{ulid}/categories` (order = display order).
 */
class SyncCategoriesRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $exists = Rule::exists('categories', 'ulid')->whereNull('deleted_at');

        if ($this->onlyActiveCategories()) {
            $exists = $exists->where('is_active', true);
        }

        return [
            'category_ulids' => ['present', 'array', 'max:200'],
            'category_ulids.*' => ['string', 'distinct', $exists],
        ];
    }

    /**
     * @return list<string>
     */
    public function categoryUlids(): array
    {
        /** @var list<string> $ulids */
        $ulids = array_values($this->validated('category_ulids') ?? []);

        return $ulids;
    }

    protected function onlyActiveCategories(): bool
    {
        return false;
    }
}
