<?php

namespace App\Http\Requests\Auth;

use App\Auth\Tokens\TwoFactorChallenges;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `POST /api/v1/auth/token/two-factor`: the challenge the password step answered with and exactly one second factor. There is no
 * email, user id or device name here on purpose: they come from the challenge, so it cannot be used for anyone else.
 */
class StaffTwoFactorRequest extends FormRequest
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
        return [
            'challenge' => ['required', 'string', 'size:'.TwoFactorChallenges::LENGTH],
            'code' => ['nullable', 'string', 'max:16', 'required_without:recovery_code', 'prohibits:recovery_code'],
            'recovery_code' => ['nullable', 'string', 'max:64', 'required_without:code'],
        ];
    }
}
