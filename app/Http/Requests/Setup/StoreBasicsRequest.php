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
            // The ORIGIN the widgets, embed code and signed links are built from: no path, query or fragment (a trailing slash is fine).
            'app_url' => ['required', 'string', 'url:http,https', 'max:255', function (string $attribute, mixed $value, \Closure $fail): void {
                $parts = parse_url((string) $value);

                if (($parts['query'] ?? null) !== null || ($parts['fragment'] ?? null) !== null || ! in_array($parts['path'] ?? '', ['', '/'], true)) {
                    $fail(__('Enter the address without a path, for example https://chat.example.com.'));
                }
            }],
            'locale' => ['required', 'string', Rule::in((array) config('chat.locales', ['en']))],
            'timezone' => ['required', 'string', 'timezone:all_with_bc'],
            'idle_timeout_minutes' => ['required', 'integer', 'min:5', 'max:10080'],
        ];
    }
}
