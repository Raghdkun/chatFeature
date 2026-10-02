<?php

namespace App\Domain\WhatsApp\Queries;

use App\Models\WaChat;
use Illuminate\Support\Carbon;

/**
 * The opaque cursor of `GET /whatsapp/chats`: the inbox is ordered by the time of the last message (a chat that has none yet by its
 * creation), newest first, then by id. That key can be NULL in `last_message_at`, which Laravel's own cursor paginator cannot order by, so
 * the cursor carries the sort key and the id of the last row of a page: `base64url({"t": "Y-m-d H:i:s", "i": id})`.
 */
final readonly class WaChatCursor
{
    public function __construct(
        public string $time,
        public int $id,
    ) {}

    /** The cursor that continues after `$chat`. */
    public static function after(WaChat $chat): self
    {
        $moment = $chat->last_message_at ?? $chat->created_at ?? Carbon::now();

        return new self($moment->clone()->setTimezone((string) config('app.timezone', 'UTC'))->format('Y-m-d H:i:s'), $chat->id);
    }

    /** Null for anything that is not a cursor this class made. */
    public static function decode(?string $encoded): ?self
    {
        if ($encoded === null || $encoded === '' || strlen($encoded) > 200) {
            return null;
        }

        $json = base64_decode(strtr($encoded, '-_', '+/'), true);
        $data = $json === false ? null : json_decode($json, true);

        if (! is_array($data) || ! is_string($data['t'] ?? null) || ! is_int($data['i'] ?? null) || preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/D', $data['t']) !== 1 || $data['i'] < 1) {
            return null;
        }

        return new self($data['t'], $data['i']);
    }

    public function encode(): string
    {
        return rtrim(strtr(base64_encode((string) json_encode(['t' => $this->time, 'i' => $this->id])), '+/', '-_'), '=');
    }
}
