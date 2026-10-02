<?php

namespace App\Domain\WhatsApp\Support;

use Illuminate\Support\Str;
use Throwable;

/**
 * A failure as one short line that is safe to store and to log: the exception class and its message up to the first sign of SQL
 * (`(Connection: ..., SQL: insert into wa_messages ... values (...))` carries the customer's text) or a stack trace. Never the
 * text of a message, never a secret.
 */
final class SafeError
{
    public static function describe(Throwable $exception, int $limit = 300): string
    {
        $message = (string) preg_replace('/\s*\((?:Connection|SQL):.*$/s', '', $exception->getMessage());
        $message = trim((string) preg_replace('/\s+/', ' ', $message));

        return Str::limit(class_basename($exception).($message === '' ? '' : ': '.$message), $limit, '...');
    }
}
