<?php

namespace App\Http\Requests\Setup;

use App\Auth\Enums\AuthMode;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class ChooseModeRequest extends FormRequest
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
            'mode' => [
                'required',
                Rule::enum(AuthMode::class),
                function (string $attribute, mixed $value, Closure $fail): void {
                    if ($value === AuthMode::Pizzasys->value && config('install.pizzasys_available') !== true) {
                        $fail(__('The pizzasys sign-in mode is coming soon and cannot be selected yet.'));
                    }
                },
            ],
        ];
    }
}
