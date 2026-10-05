<?php

namespace App\Http\Requests\Widgets;

use App\Http\Requests\Concerns\CleansDisplayText;
use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST /api/v1/widgets`. */
class StoreWidgetRequest extends FormRequest
{
    use CleansDisplayText;

    protected function prepareForValidation(): void
    {
        $this->cleanDisplayText(['name']);
    }

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
            'name' => ['required', 'string', 'max:120'],
        ];
    }
}
