<?php

namespace Tests\Support;

use Illuminate\Queue\Connectors\ConnectorInterface;
use Illuminate\Queue\SyncQueue;
use RuntimeException;
use Tests\TestCase;

/**
 * A queue that refuses every job ("Redis is down"), for tests of what happens when dispatching fails, and that can be brought back:
 * `queueIsDown()` makes it the default connection, `queueIsBackUp()` returns to the `sync` queue. Unlike `Bus::shouldReceive()` it leaves
 * the bus alone, so `Queue::fake()` works afterwards.
 *
 * @mixin TestCase
 */
trait InteractsWithQueueOutage
{
    protected function queueIsDown(): void
    {
        $refusing = new class extends SyncQueue
        {
            public function push($job, $data = '', $queue = null)
            {
                throw new RuntimeException('queue refused');
            }

            public function later($delay, $job, $data = '', $queue = null)
            {
                throw new RuntimeException('queue refused');
            }
        };

        $this->app['queue']->extend('refusing', fn () => new class($refusing) implements ConnectorInterface
        {
            public function __construct(private readonly SyncQueue $queue) {}

            public function connect(array $config)
            {
                return $this->queue;
            }
        });
        config(['queue.connections.refusing' => ['driver' => 'refusing'], 'queue.default' => 'refusing']);
    }

    protected function queueIsBackUp(): void
    {
        config(['queue.default' => 'sync']);
    }
}
