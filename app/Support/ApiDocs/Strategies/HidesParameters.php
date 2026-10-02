<?php

namespace App\Support\ApiDocs\Strategies;

/** Drops the parameters (and their children) a shared Form Request declares but an endpoint does not use. */
final class HidesParameters
{
    /**
     * @param  array<string, array<string, mixed>>  $parameters
     * @param  list<string>  $hidden
     * @return array<string, array<string, mixed>>
     */
    public static function from(array $parameters, array $hidden): array
    {
        if ($hidden === []) {
            return $parameters;
        }

        return array_filter($parameters, static function (string $name) use ($hidden): bool {
            foreach ($hidden as $parameter) {
                if ($name === $parameter || str_starts_with($name, $parameter.'.') || str_starts_with($name, $parameter.'[')) {
                    return false;
                }
            }

            return true;
        }, ARRAY_FILTER_USE_KEY);
    }
}
