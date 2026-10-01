<?php

namespace App\Support;

/**
 * Loads every `*.php` route file in a directory (sorted).
 *
 * Each bounded context drops its own file into routes/web, routes/api/management,
 * routes/api/public or routes/webhooks, so parallel tracks never edit one shared route file.
 */
final class RouteFiles
{
    public static function require(string $directory): void
    {
        $files = glob(rtrim($directory, '/').'/*.php') ?: [];
        sort($files);

        foreach ($files as $file) {
            require $file;
        }
    }
}
