<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Events\WaChatUpdated;
use App\Models\User;
use App\Models\WaChat;
use Illuminate\Support\Facades\Gate;

/**
 * An administrator has read a chat: the unread counter goes to zero with a guarded `UPDATE ... WHERE unread_by_admin > 0`, so a message
 * that arrives while the request runs is not wiped out by a stale read (it makes the counter 1 again after this) and a chat that was already
 * read changes and announces nothing.
 */
final class MarkChatRead
{
    public function handle(WaChat $chat, User $actor): WaChat
    {
        Gate::forUser($actor)->authorize('archive', $chat);

        $changed = WaChat::query()->whereKey($chat->id)->where('unread_by_admin', '>', 0)->update(['unread_by_admin' => 0, 'updated_at' => now()]);
        $chat = $chat->refresh();

        if ($changed === 1) {
            WaChatUpdated::dispatch($chat);
        }

        return $chat;
    }
}
