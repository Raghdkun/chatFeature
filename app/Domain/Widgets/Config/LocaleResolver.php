<?php

namespace App\Domain\Widgets\Config;

use App\Domain\Widgets\Data\WidgetTexts;

/**
 * Locale fallbacks for widget texts.
 *
 * A locale resolves to: itself (case-insensitive), else its language (`pt-BR` -> `pt`), else any available
 * variant of that language (`ar` -> `ar-SA`), else the widget's default locale. Any single text then falls back
 * to the default locale's value and finally to the built-in English string.
 */
final class LocaleResolver
{
    public const PATTERN = '/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/iD';

    /**
     * Normalise a user-supplied locale (`pt_br` -> `pt-BR` shape check only), or null when it is not a locale tag.
     */
    public static function sanitize(mixed $locale): ?string
    {
        if (! is_string($locale) || preg_match(self::PATTERN, $locale) !== 1) {
            return null;
        }

        return str_replace('_', '-', $locale);
    }

    /**
     * The available locale a request maps to, or null when none of them fits.
     *
     * @param  list<string>  $available  locales the widget has content for
     */
    public static function match(?string $requested, array $available): ?string
    {
        if ($requested === null) {
            return null;
        }

        $requested = strtolower($requested);
        $language = explode('-', $requested)[0];

        foreach ($available as $candidate) {
            if (strtolower($candidate) === $requested) {
                return $candidate;
            }
        }

        foreach ($available as $candidate) {
            if (strtolower($candidate) === $language) {
                return $candidate;
            }
        }

        foreach ($available as $candidate) {
            if (strtolower(explode('-', $candidate)[0]) === $language) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * @param  list<string>  $available  locale keys that have a texts block
     */
    public static function resolve(?string $requested, string $default, array $available): string
    {
        return self::match($requested, $available) ?? $default;
    }

    /**
     * A translated name: the translation for the locale (exact, else its language), else the base name.
     *
     * @param  array<string, string>  $translations  locale => text
     */
    public static function translate(string $name, array $translations, ?string $locale): string
    {
        $found = self::match($locale, array_map('strval', array_keys($translations)));

        return $found !== null && ($translations[$found] ?? '') !== '' ? $translations[$found] : $name;
    }

    /**
     * Complete text block for a locale: built-in English, overlaid by the default locale, overlaid by the locale itself.
     *
     * @param  array<string, array<string, string>>  $texts
     * @return array<string, string>
     */
    public static function completeTexts(array $texts, string $default, string $locale): array
    {
        $merged = WidgetTexts::ENGLISH;

        foreach ([$texts[$default] ?? [], $texts[$locale] ?? []] as $block) {
            foreach ($block as $key => $value) {
                if (array_key_exists($key, $merged) && $value !== '') {
                    $merged[$key] = $value;
                }
            }
        }

        return $merged;
    }
}
