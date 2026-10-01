<?php

namespace App\Support\Database;

use Closure;
use Illuminate\Database\DeadlockException;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * A transaction that runs again when MySQL picks it as the victim of a deadlock (1213, SQLSTATE 40001) or gives up on a lock (1205).
 *
 * Replacing the rows of one parent (domains, greetings, categories) deletes and re-inserts next to other parents' rows in the same
 * index, so two administrators saving at the same moment can abort each other (gap locks). Laravel's own attempts parameter
 * retries at once, which re-collides under load; here each retry waits a random, growing moment first. Top-level transactions only.
 * A deadlock inside a nested (savepoint) transaction surfaces as Laravel's `DeadlockException`, which is retried like the query error.
 */
final class DeadlockRetry
{
    public const ATTEMPTS = 6;

    /**
     * @template T
     *
     * @param  Closure(): T  $callback
     * @return T
     */
    public static function transaction(Closure $callback, int $attempts = self::ATTEMPTS): mixed
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                return DB::transaction($callback);
            } catch (QueryException|DeadlockException $exception) {
                if ($attempt >= $attempts || ! self::isConcurrencyError($exception)) {
                    throw $exception;
                }

                usleep(random_int(5_000, 25_000) * $attempt);
            }
        }
    }

    /**
     * A `DeadlockException` is Laravel's own wrapper: an inner (nested) transaction hit a deadlock, MySQL already rolled back the whole
     * outer transaction, and Laravel throws this instead of the query error. It only ever wraps a concurrency error, so it is retried.
     */
    private static function isConcurrencyError(QueryException|DeadlockException $exception): bool
    {
        if ($exception instanceof DeadlockException) {
            return true;
        }

        return $exception->getCode() === '40001'
            || in_array($exception->errorInfo[1] ?? null, [1213, 1205], true);
    }
}
