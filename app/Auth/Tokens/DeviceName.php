<?php

namespace App\Auth\Tokens;

/**
 * The label a signed-in device gives itself ("Pixel 9", "Sam's iPhone"). It is stored as plain text and shown in `GET /auth/tokens`
 * and the token audit rows, so what comes in is made harmless first: control characters, bidirectional overrides and other invisible
 * formatting characters go (a label that renders "backwards" or hides a part of itself is a spoofing tool), `<` and `>` go, white space
 * collapses and the length is capped. Clients still render it as text, never as markup.
 */
final class DeviceName
{
    public const MIN_LENGTH = 3;

    public const MAX_LENGTH = 60;

    public static function clean(string $raw): string
    {
        $withoutInvisible = preg_replace('/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]+/u', ' ', $raw);

        // Not valid UTF-8: there is nothing safe to keep.
        if ($withoutInvisible === null) {
            return '';
        }

        $collapsed = preg_replace('/\s+/u', ' ', $withoutInvisible) ?? '';

        return trim(mb_substr(trim($collapsed), 0, self::MAX_LENGTH));
    }
}
