<?php

namespace App\Domain\WhatsApp\Support;

/**
 * WhatsApp chat ids as OpenWA reports them. The same customer arrives as `4915...@c.us` (whatsapp-web.js) or `4915...@s.whatsapp.net`
 * (Baileys, sometimes with a device suffix `4915...:12@s.whatsapp.net`): {@see self::normalise()} folds both into `@c.us`, so a
 * changed engine does not split one customer into two chats. A privacy id (`...@lid`) stays what it is.
 */
final class ChatId
{
    public const INDIVIDUAL = 'individual';

    public const GROUP = 'group';

    public const OTHER = 'other';

    private const MAX_LENGTH = 128;

    /** One canonical spelling of a chat id; null for anything that is not a plausible id (empty, too long, white space, control characters). */
    public static function normalise(mixed $id): ?string
    {
        if (! is_string($id)) {
            return null;
        }

        $id = trim($id);

        if ($id === '' || strlen($id) > self::MAX_LENGTH || preg_match('/[\s\x00-\x1f\x7f]/', $id) === 1) {
            return null;
        }

        if (preg_match('/^(\d{5,20})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/D', $id, $matches) === 1) {
            return $matches[1].'@c.us';
        }

        return $id;
    }

    /**
     * `individual` (a person: `@c.us`, `@s.whatsapp.net`, `@lid`), `group` (`@g.us`) or `other` (stories, channels, broadcast lists, anything
     * unknown). `$reported` is OpenWA's own `kind`: it can only make the answer stricter, never turn a group or a story into a person.
     */
    public static function kind(string $chatId, ?string $reported = null): string
    {
        $derived = match (true) {
            str_ends_with($chatId, '@g.us') => self::GROUP,
            (bool) preg_match('/^\d{5,20}@(?:c\.us|s\.whatsapp\.net)$/D', $chatId) => self::INDIVIDUAL,
            (bool) preg_match('/^\d{5,25}@lid$/D', $chatId) => self::INDIVIDUAL,
            default => self::OTHER,
        };

        if ($derived !== self::INDIVIDUAL) {
            return $derived;
        }

        return match ($reported === null ? '' : strtolower(trim($reported))) {
            '', 'unknown', 'individual' => self::INDIVIDUAL,
            'group' => self::GROUP,
            default => self::OTHER,
        };
    }
}
