<?php

namespace App\Http\Requests\WhatsApp;

use Illuminate\Foundation\Http\FormRequest;

/** Body of `PATCH /whatsapp/sessions/{ulid}`: the session's pacing overrides (`null` = back to the global setting). */
class UpdateSessionRequest extends FormRequest
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
            'send_min_interval_ms' => ['sometimes', 'nullable', 'integer', 'min:0', 'max:60000'],
            'daily_send_cap' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:10000'],
        ];
    }

    /**
     * @return array<string, int|null>
     */
    public function pacing(): array
    {
        return array_map(static fn (mixed $value): ?int => $value === null ? null : (int) $value, $this->validated());
    }
}
