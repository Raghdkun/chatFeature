<?php

namespace Tests\Feature\Support;

use App\Support\Database\DeadlockRetry;
use Illuminate\Database\QueryException;
use PDOException;
use Tests\TestCase;

class DeadlockRetryTest extends TestCase
{
    private function mysqlError(int $driverCode, string $sqlState): QueryException
    {
        $previous = new PDOException('SQLSTATE['.$sqlState.']: driver error');
        $previous->errorInfo = [$sqlState, $driverCode, 'driver error'];

        $exception = new QueryException('mysql', 'delete from `widget_domains`', [], $previous);
        $exception->errorInfo = $previous->errorInfo;

        return $exception;
    }

    public function test_a_deadlock_victim_runs_again_and_returns_the_result(): void
    {
        $runs = 0;

        $result = DeadlockRetry::transaction(function () use (&$runs): string {
            $runs++;

            if ($runs < 3) {
                throw $this->mysqlError(1213, '40001');
            }

            return 'saved';
        });

        $this->assertSame('saved', $result);
        $this->assertSame(3, $runs);
    }

    public function test_a_lock_wait_timeout_is_retried_too(): void
    {
        $runs = 0;

        DeadlockRetry::transaction(function () use (&$runs): void {
            if (++$runs === 1) {
                throw $this->mysqlError(1205, 'HY000');
            }
        });

        $this->assertSame(2, $runs);
    }

    public function test_it_gives_up_after_the_last_attempt(): void
    {
        $runs = 0;

        try {
            DeadlockRetry::transaction(function () use (&$runs): void {
                $runs++;

                throw $this->mysqlError(1213, '40001');
            }, 3);

            $this->fail('The deadlock should have been rethrown.');
        } catch (QueryException $exception) {
            $this->assertSame(1213, $exception->errorInfo[1]);
        }

        $this->assertSame(3, $runs);
    }

    public function test_any_other_database_error_is_not_retried(): void
    {
        $runs = 0;

        try {
            DeadlockRetry::transaction(function () use (&$runs): void {
                $runs++;

                throw $this->mysqlError(1062, '23000');
            });

            $this->fail('The duplicate key should have been rethrown.');
        } catch (QueryException) {
            $this->assertSame(1, $runs);
        }
    }
}
