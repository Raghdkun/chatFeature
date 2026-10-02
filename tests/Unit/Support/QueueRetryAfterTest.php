<?php

namespace Tests\Unit\Support;

use App\Domain\Notifications\Jobs\SendPushToUser;
use Illuminate\Contracts\Queue\ShouldQueue;
use ReflectionClass;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

/**
 * C12: a queue connection that hands a job to another worker (`retry_after`) before the first worker's own timeout has passed runs it twice
 * (a WhatsApp reply would reach the customer twice). Every job of the application must time out before the default `retry_after` of the
 * database and Redis connections.
 */
class QueueRetryAfterTest extends TestCase
{
    /**
     * @return array<string, int> job class => its `timeout`
     */
    private function timeouts(): array
    {
        $timeouts = [];

        foreach ((new Finder)->files()->in(app_path('Domain'))->name('*.php')->path('Jobs') as $file) {
            $class = 'App\\'.str_replace(['/', '.php'], ['\\', ''], substr($file->getPathname(), strlen(app_path()) + 1));

            if (! class_exists($class) || ! is_subclass_of($class, ShouldQueue::class)) {
                continue;
            }

            $reflection = new ReflectionClass($class);

            if ($reflection->hasProperty('timeout') && is_int($default = $reflection->getProperty('timeout')->getDefaultValue())) {
                $timeouts[$class] = $default;
            }
        }

        return $timeouts;
    }

    public function test_every_job_times_out_before_the_queue_would_hand_it_to_another_worker(): void
    {
        $timeouts = $this->timeouts();

        $this->assertNotEmpty($timeouts);
        $longest = max($timeouts);

        foreach (['database', 'redis'] as $connection) {
            $this->assertGreaterThan($longest, (int) config("queue.connections.{$connection}.retry_after"), "retry_after of the {$connection} queue is not above the longest job timeout ({$longest} s)");
        }
    }

    public function test_the_push_job_derives_its_timeout_from_its_deadline_and_stays_below_it_too(): void
    {
        config(['push.job.deadline_seconds' => 60]);
        $job = new SendPushToUser(1, [], 0);

        $this->assertSame(90, $job->timeout);
        $this->assertLessThan((int) config('queue.connections.redis.retry_after'), $job->timeout);
    }
}
