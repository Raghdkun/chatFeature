<?php

namespace App\Http\Requests\Agents;

use App\Domain\Agents\AuthModeGuard;
use App\Http\Requests\Concerns\CleansDisplayText;
use App\Models\User;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;

/**
 * Body of `POST /api/v1/agents` (mode 1 only; the controller rejects mode 2 first).
 */
class StoreAgentRequest extends FormRequest
{
    use CleansDisplayText;

    protected function prepareForValidation(): void
    {
        $this->cleanDisplayText(['name']);
    }

    /**
     * Mode 2 (pizzasys) owns staff accounts: refuse before looking at the body (`409 managed_by_auth_portal`).
     */
    public function authorize(): bool
    {
        app(AuthModeGuard::class)->requireManageable();

        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255', Rule::unique(User::class, 'email')],
            'password' => ['required', 'string', Password::default(), 'max:255'],
            // Agents always take chats; the field exists for forward compatibility with the contract.
            'is_agent' => ['sometimes', 'accepted'],
            'category_ulids' => ['sometimes', 'array', 'max:200'],
            'category_ulids.*' => ['string', 'distinct', Rule::exists('categories', 'ulid')->whereNull('deleted_at')],
        ];
    }

    /**
     * @return list<string>
     */
    public function categoryUlids(): array
    {
        /** @var list<string> $ulids */
        $ulids = array_values((array) ($this->validated('category_ulids') ?? []));

        return $ulids;
    }
}
