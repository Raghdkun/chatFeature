<?php

namespace App\Http\Requests\Widgets;

use App\Domain\Widgets\Enums\OfflineMode;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Body of `PATCH /api/v1/widgets/{ulid}`: operational settings, every field optional. */
class UpdateWidgetRequest extends FormRequest
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
            'name' => ['sometimes', 'required', 'string', 'max:120'],
            'is_enabled' => ['sometimes', 'boolean'],
            'locale' => ['sometimes', 'required', 'string', 'regex:/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/D'],
            'idle_timeout_minutes' => ['sometimes', 'integer', 'between:5,10080'],
            'queue_timeout_seconds' => ['sometimes', 'integer', 'between:15,600'],
            'offline_mode' => ['sometimes', Rule::enum(OfflineMode::class)],
            'timezone' => ['sometimes', 'required', 'string', 'timezone:all_with_bc'],
            'allow_non_browser_clients' => ['sometimes', 'boolean'],
        ];
    }
}
