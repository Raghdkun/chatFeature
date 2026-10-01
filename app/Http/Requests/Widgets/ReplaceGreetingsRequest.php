<?php

namespace App\Http\Requests\Widgets;

use App\Domain\Widgets\Config\LocaleResolver;
use App\Domain\Widgets\Rules\SafeAssetUrl;
use App\Models\Widget;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `PUT /api/v1/widgets/{ulid}/greetings`: the complete greeting pool. Bodies are plain text (never HTML).
 */
class ReplaceGreetingsRequest extends FormRequest
{
    public const MAX_GREETINGS = 100;

    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'greetings' => ['present', 'array', 'max:'.self::MAX_GREETINGS],
            'greetings.*' => ['array'],
            'greetings.*.ulid' => ['sometimes', 'nullable', 'string', 'ulid', 'distinct'],
            'greetings.*.body' => ['required', 'string', 'max:2000', 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/uD'],
            'greetings.*.agent_name' => ['sometimes', 'nullable', 'string', 'max:120'],
            'greetings.*.agent_avatar_url' => ['sometimes', 'nullable', new SafeAssetUrl],
            'greetings.*.locale' => ['sometimes', 'nullable', 'string', 'max:'.LocaleResolver::MAX_LENGTH, 'regex:/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/D'],
            'greetings.*.weight' => ['sometimes', 'integer', 'between:1,100'],
            'greetings.*.is_active' => ['sometimes', 'boolean'],
            'greetings.*.sort_order' => ['sometimes', 'integer', 'between:0,100000'],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $widget = $this->route('widget');

                if (! $widget instanceof Widget || $validator->errors()->isNotEmpty()) {
                    return;
                }

                $known = $widget->greetings()->pluck('ulid')->all();

                foreach ((array) $this->input('greetings', []) as $index => $greeting) {
                    $ulid = is_array($greeting) ? ($greeting['ulid'] ?? null) : null;

                    if (is_string($ulid) && ! in_array($ulid, $known, true)) {
                        $validator->errors()->add("greetings.{$index}.ulid", __('This greeting does not belong to the widget.'));
                    }
                }
            },
        ];
    }

    /**
     * Validated greetings with defaults applied (weight 1, active, `sort_order` = position).
     *
     * @return list<array{ulid: string|null, body: string, agent_name: string|null, agent_avatar_url: string|null, locale: string|null, weight: int, is_active: bool, sort_order: int}>
     */
    public function normalizedGreetings(): array
    {
        $items = [];

        foreach (array_values((array) $this->validated('greetings')) as $position => $greeting) {
            $items[] = [
                'ulid' => $greeting['ulid'] ?? null,
                'body' => (string) $greeting['body'],
                'agent_name' => $greeting['agent_name'] ?? null,
                'agent_avatar_url' => $greeting['agent_avatar_url'] ?? null,
                'locale' => $greeting['locale'] ?? null,
                'weight' => (int) ($greeting['weight'] ?? 1),
                'is_active' => (bool) ($greeting['is_active'] ?? true),
                'sort_order' => (int) ($greeting['sort_order'] ?? $position),
            ];
        }

        return $items;
    }
}
