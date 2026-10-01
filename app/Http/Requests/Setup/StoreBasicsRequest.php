<?php

namespace App\Http\Requests\Setup;

use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreBasicsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'app_name' => ['required', 'string', 'max:100'],
            'app_url' => ['required', 'string', 'url:http,https', 'max:255'],
            'locale' => ['required', 'string', Rule::in((array) config('chat.locales', ['en']))],
            'timezone' => ['required', 'string', 'timezone:all'],
            'idle_timeout_minutes' => ['required', 'integer', 'min:5', 'max:10080'],
        ];
    }
}
