<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Query of `GET /conversations` and `GET /conversations/export`: the filters (`status` as a comma-separated list, `category`
 * as a ulid or slug, `widget` a ulid, `agent` a user id or `me`, `type`, `q`, `from` / `to` on the creation time, `updated_after`)
 * plus `limit` and, for the list, the opaque `cursor`. What the caller may see is decided by the query (`Conversation::visibleTo`).
 */
class ListConversationsRequest extends FormRequest
{
    public const DEFAULT_LIMIT = 25;

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
            'status' => ['nullable', 'string', 'max:100'],
            'category' => ['nullable', 'string', 'max:100'],
            'widget' => ['nullable', 'string', 'ulid'],
            'agent' => ['nullable', 'string', 'max:20', 'regex:/^(?:me|[0-9]+)$/D'],
            'type' => ['nullable', Rule::enum(ConversationType::class)],
            'q' => ['nullable', 'string', 'max:200'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'updated_after' => ['nullable', 'date'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
            'cursor' => ['nullable', 'string', 'max:500'],
            'format' => ['nullable', Rule::in(['csv', 'json'])],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                foreach ($this->statuses() as $status) {
                    if (ConversationStatus::tryFrom($status) === null) {
                        $validator->errors()->add('status', __('Unknown status ":status".', ['status' => $status]));
                    }
                }
            },
        ];
    }

    /**
     * @return list<string>
     */
    public function statuses(): array
    {
        $value = $this->query('status');

        return is_string($value) && trim($value) !== '' ? array_values(array_filter(array_map('trim', explode(',', $value)))) : [];
    }

    /**
     * The filters for `ConversationListQuery`.
     *
     * @return array<string, mixed>
     */
    public function filters(): array
    {
        return [
            'status' => $this->statuses(),
            'category' => $this->validated('category'),
            'widget' => $this->validated('widget'),
            'agent' => $this->validated('agent'),
            'type' => $this->validated('type'),
            'q' => $this->validated('q'),
            'from' => $this->validated('from'),
            'to' => $this->validated('to'),
            'updated_after' => $this->validated('updated_after'),
        ];
    }

    public function limit(): int
    {
        return (int) ($this->validated('limit') ?? self::DEFAULT_LIMIT);
    }
}
