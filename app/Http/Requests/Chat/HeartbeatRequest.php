<?php

namespace App\Http\Requests\Chat;

use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST /me/presence/heartbeat`: `visible` (is the sending tab in the foreground), optional; absent or null = visible (older clients). */
class HeartbeatRequest extends FormRequest
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
        return ['visible' => ['sometimes', 'nullable', 'boolean']];
    }

    public function visible(): bool
    {
        $visible = $this->validated('visible');

        return $visible === null || filter_var($visible, FILTER_VALIDATE_BOOLEAN);
    }
}
