<?php

namespace App\Domain\Analytics\Support;

/**
 * A CSV cell a spreadsheet will not run: text that starts like a formula (`=`, `+`, `-`, `@`, tab, carriage return) gets a leading quote, the
 * same rule as the conversation export. Numbers pass through untouched (a negative number is not a string here).
 */
final class CsvCell
{
    public static function safe(mixed $value): mixed
    {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        if (is_string($value) && $value !== '' && in_array($value[0], ['=', '+', '-', '@', "\t", "\r"], true)) {
            return "'".$value;
        }

        return $value;
    }
}
