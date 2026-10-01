<?php

namespace App\Http\Requests\Widgets;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `PUT /api/v1/widgets/{ulid}/draft`: `{ config }`. The config itself is validated strictly by
 * WidgetConfigValidator (unknown keys, ranges, colours, URLs); this request only guarantees an object is present.
 */
class SaveDraftRequest extends FormRequest
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
        return [
            'config' => ['present', 'array'],
        ];
    }
}
