<?php

namespace App\Http\Requests\Chat;

use App\Domain\Chat\Services\PreChatRules;
use App\Models\VisitorSession;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `POST /public/conversations`: the category (a slug) and the answers of the widget's pre-chat form. Which of
 * `name` / `email` / `phone` are required, and whether `consent` must be given, is the widget's configuration, enforced
 * here on the server (`PreChatRules`).
 */
class StartConversationRequest extends FormRequest
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
        $session = $this->attributes->get('visitor_session');

        $preChat = $session instanceof VisitorSession
            ? app(PreChatRules::class)->rulesFor($session->widget, $session->visitor)
            : ['name' => ['nullable'], 'email' => ['nullable'], 'phone' => ['nullable'], 'consent' => ['nullable', 'boolean']];

        return [
            'category' => ['required', 'string', 'max:100'],
            'message' => ['nullable', 'string', 'max:'.max(100, settings()->int('chat.max_message_length', 4000))],
        ] + $preChat;
    }
}
