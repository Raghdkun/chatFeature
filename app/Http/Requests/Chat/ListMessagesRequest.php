<?php

namespace App\Http\Requests\Chat;

use Illuminate\Foundation\Http\FormRequest;

/** Query of `GET .../messages`: messages after message number `after_seq`, at most `limit` (default 100). */
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
            'after_seq' => ['nullable', 'integer', 'min:0', 'max:2147483647'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
        ];
    }

    public function afterSeq(): int
    {
        return (int) ($this->validated('after_seq') ?? 0);
    }

    public function limit(): int
    {
        return (int) ($this->validated('limit') ?? self::DEFAULT_LIMIT);
    }
}
