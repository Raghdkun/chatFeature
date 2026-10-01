<?php

namespace App\Domain\Chat\Services;

/**
 * Message bodies are plain text (decision P4-D11). Everything that is not text is dropped before a body is stored: control
 * characters (except tab and line breaks), the byte order mark and the bidirectional override / isolate controls that let a
 * sender make a link or name read differently from what it is (joiners and plain direction marks stay: scripts need them). Line endings are normalised to `\n`.
 */
final class MessageText
{
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
