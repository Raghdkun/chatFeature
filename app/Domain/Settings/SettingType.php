<?php

namespace App\Domain\Settings;

use JsonException;

/** Value types a setting may hold (stored JSON-encoded in `settings.value`). */
enum SettingType: string
{
    case String = 'string';
    case Bool = 'bool';
    case Int = 'int';
    case Json = 'json';

    public function cast(mixed $value): mixed
    {
        if ($value === null) {
            return null;
        }

        return match ($this) {
            self::String => is_scalar($value) ? (string) $value : $value,
            self::Bool => filter_var($value, FILTER_VALIDATE_BOOLEAN),
            self::Int => is_numeric($value) ? (int) $value : $value,
            self::Json => $value,
        };
    }

    /**
     * @throws JsonException
     */
    public function encode(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
