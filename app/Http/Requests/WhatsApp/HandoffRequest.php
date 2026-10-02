<?php

namespace App\Http\Requests\WhatsApp;

use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST /public/widgets/{key}/whatsapp-handoff`: the topic (`category`, a slug) the visitor picked, optional. */
class HandoffRequest extends FormRequest
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
        return ['category' => ['nullable', 'string', 'max:100', 'regex:/^[a-z0-9][a-z0-9-]*$/D']];
    }

    public function category(): ?string
    {
        $value = $this->validated('category');

        return is_string($value) && $value !== '' ? $value : null;
    }
}
