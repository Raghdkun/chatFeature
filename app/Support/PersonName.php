<?php

namespace App\Support;

/**
 * Names that are shown to people outside the staff (chat visitors, e-mail recipients): never an e-mail address. An account
 * without a usable name (a portal user whose profile has none, or a name that IS the address) is shown as the part of the address
 * before the `@`, made readable: `ann.smith+sales@example.test` -> `Ann Smith`.
 */
final class PersonName
{
    /** The readable form of an address' local part (`Agent` when nothing readable is left). */
    public static function fromEmail(string $email): string
    {
        $local = explode('+', explode('@', $email, 2)[0], 2)[0];
        $words = trim((string) preg_replace('/[._\-\s]+/u', ' ', $local));

        return $words === '' ? __('Agent') : mb_convert_case($words, MB_CASE_TITLE, 'UTF-8');
    }

    /**
     * The first candidate that is a plain name; when every candidate is empty or an address, the readable local part of the first
     * address (or of `$email`).
     *
     * @param  list<string|null>  $candidates  in order of preference
     */
    public static function visitorFacing(array $candidates, ?string $email = null): string
    {
        $address = null;

        foreach ($candidates as $candidate) {
            $candidate = trim((string) $candidate);

            if ($candidate === '') {
                continue;
            }

            if (! str_contains($candidate, '@')) {
                return $candidate;
            }

            $address ??= $candidate;
        }

        $address ??= $email;

        return $address === null || trim($address) === '' ? __('Agent') : self::fromEmail($address);
    }
}
