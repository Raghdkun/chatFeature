<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Services\MessageText;
use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST /public/offline-tickets`: a name, an address to answer to and the message. */
class CreateOfflineTicketRequest extends FormRequest
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
            'name' => ['required', 'string', 'max:120'],
            'email' => ['required', 'string', 'email', 'max:190'],
            'message' => ['required', 'string', 'max:'.MessageText::maxLength()],
            'category' => ['nullable', 'string', 'max:100'],
            'missed_conversation' => ['nullable', 'string', 'ulid'],
        ];
    }
}
