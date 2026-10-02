<?php

namespace App\Http\Requests\WhatsApp;

use Illuminate\Foundation\Http\FormRequest;

/** Body of `PUT /widgets/{ulid}/whatsapp`: `session` is a session ulid, or `null` to unlink (the key itself is required). */
class LinkWidgetRequest extends FormRequest
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
        return ['session' => ['present', 'nullable', 'string', 'ulid']];
    }

    public function sessionUlid(): ?string
    {
        $value = $this->validated('session');

        return is_string($value) && $value !== '' ? $value : null;
    }
}
