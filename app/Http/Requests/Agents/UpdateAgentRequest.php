<?php

namespace App\Http\Requests\Agents;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `PATCH /api/v1/agents/{id}`. `is_active` / `is_agent` are only honoured in mode 1 (see UpdateAgent).
 */
class UpdateAgentRequest extends FormRequest
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
            'max_concurrent_chats' => ['sometimes', 'integer', 'between:1,50'],
            'is_active' => ['sometimes', 'boolean'],
            'is_agent' => ['sometimes', 'boolean'],
        ];
    }
}
