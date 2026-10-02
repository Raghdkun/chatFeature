<?php

namespace App\Http\Requests\WhatsApp;

use App\Domain\WhatsApp\Actions\SendReply;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `POST /whatsapp/chats/{ulid}/messages`: a plain-text `body` (1 to 4096 characters after cleaning, which the action does) and
 * the optional `client_msg_id` (a client-made ULID that makes a repeat idempotent).
 */
class SendReplyRequest extends FormRequest
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
            'body' => ['required', 'string', 'max:'.(SendReply::MAX_LENGTH * 2)],
            'client_msg_id' => ['nullable', 'string', 'ulid'],
        ];
    }

    public function clientMsgId(): ?string
    {
        $value = $this->validated('client_msg_id');

        return is_string($value) && $value !== '' ? strtolower($value) : null;
    }
}
