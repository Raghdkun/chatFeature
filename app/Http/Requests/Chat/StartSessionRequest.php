<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Services\PreChatRules;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `POST /public/widgets/{key}/sessions`. Everything is optional: an anonymous visitor sends only the page and locale.
 * Unsigned `visitor` data is bounded here (it is stored as given and marked unverified).
 */
class StartSessionRequest extends FormRequest
{
    public const META_ENTRIES = 20;

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
            'identity_token' => ['nullable', 'string', 'max:8192'],
            'visitor' => ['nullable', 'array'],
            'visitor.name' => ['nullable', 'string', 'max:120'],
            'visitor.email' => ['nullable', 'string', 'email', 'max:190'],
            'visitor.phone' => ['nullable', 'string', 'regex:'.PreChatRules::PHONE_PATTERN],
            'visitor.meta' => ['nullable', 'array', 'max:'.self::META_ENTRIES],
            'visitor.meta.*' => ['nullable', function (string $attribute, mixed $value, \Closure $fail): void {
                if (! is_scalar($value) || (is_string($value) && mb_strlen($value) > 500)) {
                    $fail(__('Each value must be a number, boolean or text of 500 characters at most.'));
                }
            }],
            'page' => ['nullable', 'array'],
            'page.url' => ['nullable', 'string', 'max:2048'],
            'page.title' => ['nullable', 'string', 'max:255'],
            'page.referrer' => ['nullable', 'string', 'max:2048'],
            'locale' => ['nullable', 'string', 'max:12', 'regex:/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/D'],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $meta = $this->input('visitor.meta');

                if (! is_array($meta)) {
                    return;
                }

                foreach (array_keys($meta) as $key) {
                    if (! is_string($key) || preg_match('/^[A-Za-z0-9_.\-]{1,64}$/D', $key) !== 1) {
                        $validator->errors()->add('visitor.meta', __('Keys may contain letters, digits, dots, dashes and underscores (64 characters at most).'));

                        return;
                    }
                }
            },
        ];
    }
}
