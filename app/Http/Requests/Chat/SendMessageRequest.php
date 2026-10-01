<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Actions\SendMessage;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `POST .../messages` (visitor and staff): `client_msg_id` (client-generated ULID, makes a retry idempotent), a text
 * `body` and/or uploaded `attachments` (ulids). The body is plain text, cleaned by the action.
 */
class SendMessageRequest extends FormRequest
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
            'client_msg_id' => ['nullable', 'string', 'ulid'],
            'body' => ['nullable', 'string', 'max:'.max(100, settings()->int('chat.max_message_length', 4000)), 'required_without:attachments'],
            'attachments' => ['nullable', 'array', 'max:'.SendMessage::MAX_ATTACHMENTS, 'required_without:body'],
            'attachments.*' => ['string', 'ulid', 'distinct'],
        ];
    }

    public function clientMsgId(): ?string
    {
        $value = $this->validated('client_msg_id');

        return is_string($value) && $value !== '' ? $value : null;
    }

    /**
     * @return list<string>
     */
    public function attachmentUlids(): array
    {
        return array_values(array_map(strval(...), (array) $this->validated('attachments', [])));
    }
}
