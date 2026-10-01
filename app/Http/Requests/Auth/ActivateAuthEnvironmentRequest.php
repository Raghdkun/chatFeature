<?php

namespace App\Http\Requests\Auth;

use App\Data\Auth\EnvironmentKey;
use App\Models\User;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

/** Settings > Auth: make an environment the active one (needs an admin login on the TARGET environment). */
class ActivateAuthEnvironmentRequest extends FormRequest
{
    public function authorize(): bool
    {
        $user = $this->user();

        return $user instanceof User && $user->is_admin && $user->is_active;
    }

    /** A refused request is answered like every other refused switch: `422 {ok: false, message}` (+ per-field `errors`). */
    protected function failedValidation(Validator $validator): void
    {
        throw new HttpResponseException(response()->json([
            'ok' => false,
            'message' => $validator->errors()->first(),
            'errors' => $validator->errors()->toArray(),
        ], 422));
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'env' => ['required', Rule::enum(EnvironmentKey::class)],
            'email' => ['required', 'string', 'email', 'max:255'],
            'password' => ['required', 'string', 'max:255'],
            'confirm' => ['required', 'accepted'],
        ];
    }
}
