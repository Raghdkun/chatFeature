<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\WhatsApp\Events\WaChatUpdated;
use App\Models\User;
use App\Models\WaChat;
use Illuminate\Support\Facades\Gate;

/** Put a chat away (`archived`) or bring it back (`open`); guarded, idempotent and audited. A new inbound message re-opens an archived chat by itself. */
final class SetChatArchived
{
    public function __construct(private readonly AuditLogger $audit) {}

    public function handle(WaChat $chat, bool $archived, User $actor): WaChat
    {
        Gate::forUser($actor)->authorize('archive', $chat);

        $to = $archived ? WaChatStatus::Archived : WaChatStatus::Open;
        $changed = WaChat::query()->whereKey($chat->id)->where('status', '!=', $to->value)->update(['status' => $to->value, 'updated_at' => now()]);
        $chat = $chat->refresh();

        if ($changed === 1) {
            $this->audit->record($archived ? 'whatsapp.chat.archived' : 'whatsapp.chat.unarchived', $chat, [], $actor);
            WaChatUpdated::dispatch($chat);
        }

        return $chat;
    }
}
