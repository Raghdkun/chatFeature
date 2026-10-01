<?php

namespace App\Http\Requests\Setup;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\InstallState;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Password;

/**
 * First administrator (mode `fortify` only). There is no database yet, so email uniqueness is not
 * checked here; `create-admin` reconciles it.
 */
class StoreAdminRequest extends FormRequest
{
    public function authorize(): bool
    {
        return app(InstallState::class)->mode() === AuthMode::Fortify->value;
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255'],
            'password' => ['required', 'string', Password::default(), 'confirmed'],
        ];
    }
}
