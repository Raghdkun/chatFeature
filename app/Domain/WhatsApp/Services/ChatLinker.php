<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\WhatsApp\Events\WaChatLinked;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Support\Database\DeadlockRetry;

/**
 * Links a recorded WhatsApp chat to the widget, visitor and topic it came from (decision P6-D3). The visitor's hand-off gave them an
 * 8-character code and a `wa.me` link with the code typed in; the first inbound messages of a chat that no ticket has linked yet are
 * searched for such a code.
 *
 *  - Only a LIVE ticket of THIS session links (not consumed, not expired; a code sent to another number links nothing).
 *  - A code is a whole word: bounded by anything that is not a letter or a digit, case-insensitive, from the ticket alphabet only
 *    (no 0 / O / 1 / I / L, so look-alike spellings and letters of other scripts never match, and a code inside a longer word does not).
 *  - One ticket links one chat and one chat takes one ticket: the ticket is claimed with a guarded `UPDATE ... WHERE consumed_at IS NULL`
 *    inside a transaction that holds the chat's row lock, so two messages (or two deliveries) racing for the same code link it once.
 *  - A chat stays recorded when nothing matches (it is simply unlinked), and a chat that is already linked is never re-linked.
 *  - The claim runs in `DeadlockRetry`: the chat row lock and the ticket update can make MySQL pick this transaction as a deadlock victim
 *    when two deliveries hit the same chat or ticket, and the second run finds the work done or does it.
 */
final class ChatLinker
{
    /** The whole word `K7M2QX4P`: eight characters of the ticket alphabet, not touching a letter, digit or underscore of any script. */
    private const CODE_PATTERN = '/(?<![\p{L}\p{N}_])[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}(?![\p{L}\p{N}_])/u';

    /**
     * Try the message's text; true when the chat is now linked by it.
     */
    public function attempt(WaChat $chat, WaMessage $message): bool
    {
        if ($chat->handoff_ticket_id !== null || $chat->widget_id !== null || ! $message->isInbound()) {
            return false;
        }

        $codes = $this->candidates($message->body);

        if ($codes === [] || $this->beyondTheFirstMessages($chat)) {
            return false;
        }

        $ticket = WaHandoffTicket::query()
            ->live()
            ->where('session_id', $chat->session_id)
            ->whereIn('code', $codes)
            ->orderBy('id')
            ->first();

        if ($ticket === null) {
            return false;
        }

        $linked = DeadlockRetry::transaction(function () use ($chat, $ticket): bool {
            $locked = WaChat::query()->whereKey($chat->id)->lockForUpdate()->first();

            if ($locked === null || $locked->handoff_ticket_id !== null) {
                return false;
            }

            $claimed = WaHandoffTicket::query()
                ->whereKey($ticket->id)
                ->whereNull('consumed_at')
                ->where('expires_at', '>', now())
                ->update(['consumed_at' => now(), 'wa_chat_id' => $chat->id, 'updated_at' => now()]);

            if ($claimed !== 1) {
                return false;
            }

            WaChat::query()->whereKey($chat->id)->update([
                'widget_id' => $ticket->widget_id,
                'visitor_id' => $ticket->visitor_id,
                'category_id' => $ticket->category_id,
                'handoff_ticket_id' => $ticket->id,
                'updated_at' => now(),
            ]);

            return true;
        });

        if (! $linked) {
            return false;
        }

        $chat->refresh();
        WaChatLinked::dispatch($chat, $ticket->fresh() ?? $ticket);

        return true;
    }

    /**
     * The codes in a text, upper-cased, in order of appearance, without repeats.
     *
     * @return list<string>
     */
    public function candidates(?string $text): array
    {
        if ($text === null || $text === '') {
            return [];
        }

        // ASCII-only upper-casing on purpose: a letter of another script that upper-cases to an ASCII one (a long s) must not spell a code.
        preg_match_all(self::CODE_PATTERN, strtoupper($text), $matches);

        return array_slice(array_values(array_unique($matches[0])), 0, max(1, (int) config('whatsapp.linker.max_candidates_per_message', 5)));
    }

    /** A customer pastes the code in their first messages; later ones are not searched. */
    private function beyondTheFirstMessages(WaChat $chat): bool
    {
        $limit = max(1, (int) config('whatsapp.linker.max_inbound_messages', 5));

        return WaMessage::query()->where('wa_chat_id', $chat->id)->where('direction', 'in')->count() > $limit;
    }
}
