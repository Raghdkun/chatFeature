<?php

namespace App\Domain\Chat\Services;

/**
 * Message bodies are plain text (decision P4-D11). Everything that is not text is dropped before a body is stored: control
 * characters (except tab and line breaks), the byte order mark and the bidirectional override / isolate controls that let a
 * sender make a link or name read differently from what it is (joiners and plain direction marks stay: scripts need them). Line endings are normalised to `\n`.
 */
final class MessageText
{
    /**
     * The most characters a message body may ever have, whatever the setting says: `messages.body` is a TEXT column (65,535 bytes)
     * and one character can take 4 bytes, so anything above this could fail on insert instead of validating.
     */
    public const HARD_MAX_LENGTH = 16000;

    /** The effective limit: `chat.max_message_length` (default 4000), kept between 100 and `HARD_MAX_LENGTH`. */
    public static function maxLength(): int
    {
        return min(self::HARD_MAX_LENGTH, max(100, settings()->int('chat.max_message_length', 4000)));
    }

    public static function clean(?string $text): ?string
    {
        if ($text === null) {
            return null;
        }

        $text = str_replace(["\r\n", "\r"], "\n", $text);
        $text = (string) preg_replace('/[\x{0000}-\x{0008}\x{000B}\x{000C}\x{000E}-\x{001F}\x{007F}-\x{009F}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]/u', '', $text);
        $text = trim($text);

        return $text === '' ? null : $text;
    }

    /**
     * A name (or any short label) as ONE line of text: control characters, line and paragraph separators and the bidirectional
     * overrides become spaces, runs of whitespace collapse, the ends are trimmed and the result is cut at `$max` characters. A
     * visitor's name ends up in the greeting of an e-mail and in staff screens; a line break in it must not add lines to either.
     */
    public static function singleLine(?string $text, int $max = 120): ?string
    {
        if ($text === null) {
            return null;
        }

        $text = (string) preg_replace('/[\x{0000}-\x{001F}\x{007F}-\x{009F}\x{2028}\x{2029}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]/u', ' ', $text);
        $text = trim((string) preg_replace('/\s+/u', ' ', $text));
        $text = rtrim(mb_substr($text, 0, $max));

        return $text === '' ? null : $text;
    }

    /** One-line excerpt for lists and notifications. */
    public static function preview(?string $text, int $length = 160): ?string
    {
        if ($text === null || $text === '') {
            return null;
        }

        $line = trim((string) preg_replace('/\s+/u', ' ', $text));

        return mb_strlen($line) > $length ? rtrim(mb_substr($line, 0, $length - 1)).'…' : $line;
    }
}
