<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Body of `PUT /me/presence`. */
class SetPresenceRequest extends FormRequest
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
        return ['status' => ['required', 'string', Rule::enum(PresenceStatus::class)]];
    }

    public function status(): PresenceStatus
    {
        return PresenceStatus::from((string) $this->validated('status'));
    }
}
