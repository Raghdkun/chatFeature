<?php

namespace App\Http\Requests\Setup;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\InstallState;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;

/** Mode 2: the portal administrator who finishes the setup (verified live; the password is never stored). */
class PortalAdminRequest extends FormRequest
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
            'email' => ['required', 'string', 'email', 'max:255'],
            'password' => ['required', 'string', 'max:255'],
        ];
    }
}
