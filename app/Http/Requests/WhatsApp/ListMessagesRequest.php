<?php

namespace App\Http\Requests\WhatsApp;

use Illuminate\Foundation\Http\FormRequest;

/** Query of `GET /whatsapp/chats/{ulid}/messages`: `after_id` or `before_id` (message ulids), `limit`. */
class ListMessagesRequest extends FormRequest
{
    public const DEFAULT_LIMIT = 100;

    public const MAX_LIMIT = 200;

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
            'after_id' => ['nullable', 'string', 'ulid', 'prohibits:before_id'],
            'before_id' => ['nullable', 'string', 'ulid'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
        ];
    }

    public function limit(): int
    {
        return (int) ($this->validated('limit') ?? self::DEFAULT_LIMIT);
    }
}
