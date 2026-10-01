<?php

namespace Tests\Feature\Support;

use App\Support\Database\DeadlockRetry;
use Illuminate\Database\DeadlockException;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
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

    public function test_a_deadlock_inside_a_nested_transaction_is_retried_too(): void
    {
        $runs = 0;

        // Laravel turns the deadlock of an inner (savepoint) transaction into its own DeadlockException (the outer transaction is gone).
        $result = DeadlockRetry::transaction(function () use (&$runs): string {
            $runs++;

            return DB::transaction(function () use ($runs): string {
                if ($runs < 3) {
                    $previous = new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction');
                    $previous->errorInfo = ['40001', 1213, 'Deadlock found when trying to get lock; try restarting transaction'];

                    throw new QueryException('mysql', 'update `conversations` set ...', [], $previous);
                }

                return 'saved';
            });
        });

        $this->assertSame('saved', $result);
        $this->assertSame(3, $runs);
    }

    public function test_a_nested_deadlock_that_keeps_happening_is_rethrown_after_the_last_attempt(): void
    {
        $runs = 0;

        try {
            DeadlockRetry::transaction(function () use (&$runs): void {
                $runs++;

                DB::transaction(function (): void {
                    throw new QueryException('mysql', 'update x', [], new PDOException('Deadlock found when trying to get lock'));
                });
            }, 2);

            $this->fail('The deadlock should have been rethrown.');
        } catch (DeadlockException) {
            $this->assertSame(2, $runs);
        }
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
