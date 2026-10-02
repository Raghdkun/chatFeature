<?php

namespace App\Http\Requests\WhatsApp;

use App\Models\WhatsAppSession;
use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST /whatsapp/sessions`: the session's name (OpenWA: 3-50 letters, digits and hyphens). */
class CreateSessionRequest extends FormRequest
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
        return ['name' => ['required', 'string', 'regex:'.WhatsAppSession::NAME_PATTERN]];
    }

    public function messages(): array
    {
        return ['name.regex' => __('A session name has 3 to 50 letters, digits or hyphens.')];
    }
}
