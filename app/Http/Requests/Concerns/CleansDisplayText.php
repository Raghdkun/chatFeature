<?php

namespace App\Http\Requests\Concerns;

/**
 * Names and labels an administrator types (staff, topics, widgets) are shown to visitors and colleagues and end up in page titles and
 * e-mail greetings. Bidirectional overrides (U+202A-202E, U+2066-2069), control characters and line breaks are turned into spaces before
 * validation, exactly what visitors' names and messages already get, so one name cannot reorder the text around it.
 */
trait CleansDisplayText
{
    /**
     * @param  list<string>  $keys  request keys holding a string, or an array of strings (`name_i18n`)
     */
    protected function cleanDisplayText(array $keys): void
    {
        $clean = [];

        foreach ($keys as $key) {
            $value = $this->input($key);

            if (is_string($value)) {
                $clean[$key] = self::oneCleanLine($value);
            } elseif (is_array($value)) {
                $clean[$key] = array_map(fn (mixed $item): mixed => is_string($item) ? self::oneCleanLine($item) : $item, $value);
            }
        }

        if ($clean !== []) {
            $this->merge($clean);
        }
    }

    private static function oneCleanLine(string $text): string
    {
        $text = (string) preg_replace('/[\x{0000}-\x{001F}\x{007F}-\x{009F}\x{2028}\x{2029}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]/u', ' ', $text);

        return trim((string) preg_replace('/\s+/u', ' ', $text));
    }
}
