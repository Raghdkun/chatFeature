<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Support\Database\DeadlockRetry;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Storage;

/**
 * `DELETE /whatsapp/chats/{ulid}`: erases one customer's chat for good (a request under a data-protection law, a mistake, a retention
 * decision): the chat, every message, and every image stored for them. Administrators only (`WhatsAppPolicy::delete`, asked again here).
 *
 * Idempotent: a chat that is already gone is a success and changes nothing. The rows go in one transaction (messages cascade; a hand-off
 * ticket that linked the chat keeps existing, unlinked, and the visitor side is untouched), the image files after it (a failed file delete
 * leaves an orphan that `whatsapp:prune` removes within a day). The audit entry carries ids and counts, never the number, the name or any text.
 */
final class DeleteWaChat
{
    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @return bool true when a chat was deleted, false when there was none (already deleted, or never there)
     */
    public function handle(string $chatUlid, User $actor): bool
    {
        Gate::forUser($actor)->authorize('delete', WaChat::class);

        $chat = WaChat::query()->where('ulid', strtolower($chatUlid))->first();

        if ($chat === null) {
            return false;
        }

        Gate::forUser($actor)->authorize('delete', $chat);

        /** @var list<string> $files */
        $files = [];
        $messages = 0;

        $deleted = DeadlockRetry::transaction(function () use ($chat, &$files, &$messages): bool {
            $locked = WaChat::query()->whereKey($chat->id)->lockForUpdate()->first();

            if ($locked === null) {
                return false;
            }

            $files = WaMessage::query()->where('wa_chat_id', $locked->id)->whereNotNull('media_path')->pluck('media_path')->filter()->values()->all();
            $messages = WaMessage::query()->where('wa_chat_id', $locked->id)->count();
            $locked->delete();

            return true;
        });

        if (! $deleted) {
            return false;
        }

        $disk = Storage::disk(WaMediaStore::disk());

        foreach ($files as $path) {
            $disk->delete($path);
        }

        $this->audit->record('whatsapp.chat.deleted', $chat, ['chat' => $chat->ulid, 'messages' => $messages, 'files' => count($files)], $actor);

        return true;
    }
}
