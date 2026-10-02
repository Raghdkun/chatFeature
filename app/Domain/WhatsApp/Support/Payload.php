<?php

namespace App\Domain\WhatsApp\Support;

use Carbon\CarbonImmutable;
use Throwable;

/**
 * Tolerant reads of an OpenWA webhook object: whatever is missing, null or of another type is simply "not there", never an exception.
 * An unknown field is ignored, so a newer OpenWA never fails a delivery.
 */
final class Payload
{
    /**
     * @param  array<array-key, mixed>  $data
     */
    public static function string(array $data, string $key, int $max = 255): ?string
    {
        $value = $data[$key] ?? null;

        if (! is_string($value) && ! is_int($value)) {
            return null;
        }

        $value = trim((string) $value);

        return $value === '' ? null : mb_substr($value, 0, $max);
    }

    /**
     * @param  array<array-key, mixed>  $data
     */
    public static function bool(array $data, string $key): bool
    {
        return ($data[$key] ?? false) === true;
    }

    /**
     * @param  array<array-key, mixed>  $data
     * @return array<array-key, mixed>
     */
    public static function array(array $data, string $key): array
    {
        $value = $data[$key] ?? null;

        return is_array($value) ? $value : [];
    }

    /** A moment from epoch seconds (OpenWA), epoch milliseconds, or an ISO string; null when it is none of them. */
    public static function moment(mixed $value): ?CarbonImmutable
    {
        try {
            if (is_int($value) || is_float($value) || (is_string($value) && ctype_digit($value))) {
                $number = (float) $value;

                if ($number <= 0) {
                    return null;
                }

                return CarbonImmutable::createFromTimestampUTC((int) ($number > 100_000_000_000 ? $number / 1000 : $number));
            }

            return is_string($value) && $value !== '' ? CarbonImmutable::parse($value) : null;
        } catch (Throwable) {
            return null;
        }
    }
}
