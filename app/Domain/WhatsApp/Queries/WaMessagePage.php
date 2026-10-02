<?php

namespace App\Domain\WhatsApp\Queries;

use App\Models\WaChat;
use App\Models\WaMessage;
use Illuminate\Validation\ValidationException;

/**
 * A page of a chat's transcript, always oldest first: `after_id` (the page after that message: the sync call after a reconnect),
 * `before_id` (the page before it) or neither (the newest page). Cursors are message ulids (never the integer id); a message that is not in
 * THIS chat is a `422`. `next` is the `after_id` of the following page and `prev` the `before_id` of the previous one, null at the ends.
 */
final class WaMessagePage
{
    /**
     * @return array{messages: list<WaMessage>, next_cursor: string|null, prev_cursor: string|null}
     *
     * @throws ValidationException
     */
    public function fetch(WaChat $chat, ?string $afterUlid, ?string $beforeUlid, int $limit): array
    {
        $base = fn () => WaMessage::query()->with('sentBy')->where('wa_chat_id', $chat->id);

        if ($afterUlid !== null) {
            $cursor = $this->cursor($chat, $afterUlid, 'after_id');
            $rows = $base()->where('id', '>', $cursor->id)->orderBy('id')->limit($limit + 1)->get();
            $more = $rows->count() > $limit;
            $page = $rows->take($limit)->values();

            return $this->result($chat, $page->all(), next: $more, prev: $page->isNotEmpty() && WaMessage::query()->where('wa_chat_id', $chat->id)->where('id', '<', $page->first()->id)->exists());
        }

        if ($beforeUlid !== null) {
            $cursor = $this->cursor($chat, $beforeUlid, 'before_id');
            $rows = $base()->where('id', '<', $cursor->id)->orderByDesc('id')->limit($limit + 1)->get();
            $more = $rows->count() > $limit;
            $page = $rows->take($limit)->reverse()->values();

            return $this->result($chat, $page->all(), next: $page->isNotEmpty(), prev: $more);
        }

        $rows = $base()->orderByDesc('id')->limit($limit + 1)->get();
        $more = $rows->count() > $limit;
        $page = $rows->take($limit)->reverse()->values();

        return $this->result($chat, $page->all(), next: false, prev: $more);
    }

    /**
     * @param  array<int, WaMessage>  $page
     * @return array{messages: list<WaMessage>, next_cursor: string|null, prev_cursor: string|null}
     */
    private function result(WaChat $chat, array $page, bool $next, bool $prev): array
    {
        $messages = array_values($page);

        foreach ($messages as $message) {
            $message->setRelation('chat', $chat);
        }

        return [
            'messages' => $messages,
            'next_cursor' => $next && $messages !== [] ? $messages[array_key_last($messages)]->ulid : null,
            'prev_cursor' => $prev && $messages !== [] ? $messages[0]->ulid : null,
        ];
    }

    /**
     * @throws ValidationException
     */
    private function cursor(WaChat $chat, string $ulid, string $field): WaMessage
    {
        return WaMessage::query()->where('wa_chat_id', $chat->id)->where('ulid', strtolower($ulid))->first()
            ?? throw ValidationException::withMessages([$field => [__('That message is not in this chat.')]]);
    }
}
