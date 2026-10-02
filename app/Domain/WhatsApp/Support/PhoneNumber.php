<?php

namespace App\Domain\WhatsApp\Support;

/**
 * Phone numbers as WhatsApp and OpenWA spell them. OpenWA reports a number as bare digits (`6281234567890`, `phone` of a session) or
 * inside a chat id (`6281234567890@c.us`); the application stores `+6281234567890` (E.164, at most 15 digits).
 *
 * A privacy id (`...@lid`), a group (`...@g.us`) and anything else that is not a phone number gives null: never a made-up number.
 */
final class PhoneNumber
{
    /** E.164 allows 15 digits; a shorter run is not a number anybody can call. */
    private const MIN_DIGITS = 7;

    private const MAX_DIGITS = 15;

    /** `+<digits>` for something that holds a plausible number (`4915123456789`, `+49 151 234 5678`); null otherwise. */
    public static function e164(?string $value): ?string
    {
        $digits = self::digits($value);

        return $digits === null ? null : '+'.$digits;
    }

    /** Only the digits, when there are between 7 and 15 of them. */
    public static function digits(?string $value): ?string
    {
        $digits = preg_replace('/\D+/', '', (string) $value) ?? '';

        return strlen($digits) >= self::MIN_DIGITS && strlen($digits) <= self::MAX_DIGITS ? $digits : null;
    }

    /** The number behind a WhatsApp chat id: only a person's `@c.us` / `@s.whatsapp.net` id carries one. */
    public static function fromChatId(?string $chatId): ?string
    {
        $chatId = trim((string) $chatId);

        if (preg_match('/^(\d{7,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/', $chatId, $matches) !== 1) {
            return null;
        }

        return '+'.$matches[1];
    }

    /** Whether a chat id is a group (`...@g.us`). */
    public static function isGroupChatId(?string $chatId): bool
    {
        return str_ends_with(trim((string) $chatId), '@g.us');
    }

    /** `+49 ••• 6789`-style display: the country part (the first two digits), the last four, bullets between. Null when there is no number. */
    public static function mask(?string $value): ?string
    {
        $digits = self::digits($value);

        if ($digits === null) {
            return null;
        }

        $hidden = max(1, strlen($digits) - 6);

        return '+'.substr($digits, 0, 2).str_repeat('•', $hidden).substr($digits, -4);
    }
}
