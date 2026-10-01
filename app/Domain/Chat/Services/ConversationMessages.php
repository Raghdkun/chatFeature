<?php

namespace App\Domain\Chat\Services;

use App\Models\Conversation;
use App\Models\Message;

/**
 * A page of a conversation's messages in `seq` order (`GET .../messages?after_seq=N&limit=M`): the sync call clients make after a
 * reconnect, a tab becoming visible or a detected gap. `next_cursor` is the `after_seq` of the next page (the last number of this
 * one) while more messages follow, else null. Relations are loaded for `MessageData` (sender, attachments, the conversation's visitor).
 */
final class ConversationMessages
{
    /**
     * @return array{messages: list<Message>, next_cursor: string|null}
     */
    public function after(Conversation $conversation, int $afterSeq, int $limit): array
    {
        $conversation->loadMissing('visitor');

        $messages = Message::query()
            ->with(['senderUser', 'attachments'])
            ->where('conversation_id', $conversation->id)
            ->where('seq', '>', $afterSeq)
            ->orderBy('seq')
            ->limit($limit + 1)
            ->get();

        $more = $messages->count() > $limit;
        $page = $messages->take($limit)->values();
        $page->each(fn (Message $message) => $message->setRelation('conversation', $conversation));

        return [
            'messages' => array_values($page->all()),
            'next_cursor' => $more && $page->isNotEmpty() ? (string) $page->last()->seq : null,
        ];
    }
}
