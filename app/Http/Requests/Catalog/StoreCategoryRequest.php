<?php

namespace App\Http\Requests\Catalog;

use App\Domain\Catalog\Support\CategorySlugger;
use App\Domain\Widgets\Config\LocaleResolver;
use App\Models\Category;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Body of `POST /api/v1/categories`. Authorization is the route's `admin` middleware.
 */
class StoreCategoryRequest extends FormRequest
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
        return $this->categoryRules(creating: true, ignoreId: null);
    }

    /**
     * @return array<string, mixed>
     */
    protected function categoryRules(bool $creating, ?int $ignoreId): array
    {
        $required = $creating ? ['required'] : ['sometimes', 'required'];

        return [
            'name' => [...$required, 'string', 'max:120'],
            'slug' => [
                'sometimes', 'nullable', 'string', 'max:'.CategorySlugger::MAX_LENGTH, 'regex:'.CategorySlugger::PATTERN,
                Rule::unique(Category::class, 'slug')->whereNull('deleted_at')->ignore($ignoreId),
            ],
            'description' => ['sometimes', 'nullable', 'string', 'max:1000'],
            'icon' => ['sometimes', 'nullable', 'string', 'max:64', 'regex:/^[^<>"\'`\\\\]+$/uD'],
            'color' => ['sometimes', 'nullable', 'string', 'regex:/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/D'],
            'sort_order' => ['sometimes', 'integer', 'min:0', 'max:100000'],
            'is_active' => ['sometimes', 'boolean'],
            'name_i18n' => ['sometimes', 'nullable', 'array', 'max:20'],
            'name_i18n.*' => ['string', 'max:120'],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $translations = $this->input('name_i18n');

                if (! is_array($translations)) {
                    return;
                }

                foreach (array_keys($translations) as $locale) {
                    if (strlen((string) $locale) > LocaleResolver::MAX_LENGTH || preg_match(LocaleResolver::PATTERN, (string) $locale) !== 1) {
                        $validator->errors()->add('name_i18n.'.$locale, __('The locale code is invalid.'));
                    }
                }
            },
        ];
    }

    /**
     * Validated attributes ready for the model (`null` slug means "generate", `null` translations mean "none").
     *
     * @return array<string, mixed>
     */
    public function categoryAttributes(): array
    {
        $attributes = $this->validated();

        if (array_key_exists('name_i18n', $attributes)) {
            $attributes['name_i18n'] = $attributes['name_i18n'] ?? [];
        }

        if (array_key_exists('slug', $attributes) && $attributes['slug'] === null) {
            unset($attributes['slug']);
        }

        return $attributes;
    }
}
