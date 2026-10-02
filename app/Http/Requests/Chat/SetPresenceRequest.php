<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Body of `PUT /me/presence`: `status`, and optionally `automatic` (only meaningful with `online`: the dashboard keeps the agent `online`
 * while a tab is visible and moves them to `away` after the auto-away minutes of hidden tabs, instead of pinning `online`).
 */
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
        return [
            'status' => ['required', 'string', Rule::enum(PresenceStatus::class)],
            'automatic' => ['sometimes', 'boolean'],
        ];
    }

    public function automatic(): bool
    {
        return $this->boolean('automatic') && $this->status() === PresenceStatus::Online;
    }

    public function status(): PresenceStatus
    {
        return PresenceStatus::from((string) $this->validated('status'));
    }
}
