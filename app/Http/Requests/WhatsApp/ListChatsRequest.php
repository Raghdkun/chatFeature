<?php

namespace App\Http\Requests\WhatsApp;

use App\Domain\WhatsApp\Queries\WaChatCursor;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Query of `GET /whatsapp/chats` and `GET /whatsapp/export`: the inbox filters, `limit` and the opaque `cursor` (list only), `from` / `to`
 * and `format` / `resource` (export only).
 */
class ListChatsRequest extends FormRequest
{
    public const DEFAULT_LIMIT = 50;

    public const MAX_LIMIT = 100;

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
            'status' => ['nullable', Rule::in(['open', 'archived', 'all'])],
            'session' => ['nullable', 'string', 'ulid'],
            'linked' => ['nullable', 'boolean'],
            'widget' => ['nullable', 'string', 'ulid'],
            'category' => ['nullable', 'string', 'max:100'],
            'unread' => ['nullable', 'boolean'],
            'q' => ['nullable', 'string', 'max:200'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
            'cursor' => ['nullable', 'string', 'max:200'],
            'format' => ['nullable', Rule::in(['csv', 'json'])],
            'resource' => ['nullable', Rule::in(['messages', 'chats'])],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $cursor = $this->query('cursor');

                if (is_string($cursor) && $cursor !== '' && WaChatCursor::decode($cursor) === null) {
                    $validator->errors()->add('cursor', __('The cursor is not valid.'));
                }
            },
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function filters(): array
    {
        return [
            'status' => $this->validated('status'),
            'session' => $this->validated('session'),
            'linked' => $this->validated('linked'),
            'widget' => $this->validated('widget'),
            'category' => $this->validated('category'),
            'unread' => $this->validated('unread'),
            'q' => $this->validated('q'),
        ];
    }

    public function cursor(): ?WaChatCursor
    {
        return WaChatCursor::decode($this->validated('cursor'));
    }

    public function limit(): int
    {
        return (int) ($this->validated('limit') ?? self::DEFAULT_LIMIT);
    }
}
