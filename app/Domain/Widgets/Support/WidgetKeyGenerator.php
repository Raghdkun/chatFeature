<?php

namespace App\Domain\Widgets\Support;

/**
 * Generates widget public keys: `wk_` plus 20 characters from [a-z0-9] (about 103 bits, url-safe,
 * and unambiguous under MySQL's case-insensitive collations).
 */
final class WidgetKeyGenerator
{
    public const PREFIX = 'wk_';

    public const LENGTH = 20;

    private const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

    public static function generate(): string
    {
        $key = '';
        $max = strlen(self::ALPHABET) - 1;

        for ($i = 0; $i < self::LENGTH; $i++) {
            $key .= self::ALPHABET[random_int(0, $max)];
        }

        return self::PREFIX.$key;
    }
}
