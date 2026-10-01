<?php

namespace App\Http\Requests\Setup;

use App\Auth\Enums\AuthMode;
use App\Data\Auth\EnvironmentKey;
use App\Domain\Install\InstallState;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Mode 2: "Test connection" for one saved environment of the wizard. */
class TestPizzasysRequest extends FormRequest
{
    public function authorize(): bool
    {
        return app(InstallState::class)->mode() === AuthMode::Pizzasys->value;
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'env' => ['required', Rule::enum(EnvironmentKey::class)],
        ];
    }
}
