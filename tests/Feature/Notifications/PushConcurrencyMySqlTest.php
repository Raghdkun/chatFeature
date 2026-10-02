<?php

namespace Tests\Feature\Notifications;

use App\Models\AgentPresence;
use App\Models\DeviceToken;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * C10: the FIRST registration of a push endpoint, a device token or a presence row reads a row that does not exist with `FOR UPDATE` (a
 * gap lock on MySQL), so several requests doing it at the same instant used to deadlock each other. Real parallelism: several PHP
 * processes (tests/Support/push-race-worker.php) hit one database at once. SQLite cannot show a race, so this is opt-in:
 *
 *   CHAT_RACE_TEST=1 DB_CONNECTION=mysql DB_DATABASE=<a dedicated database> php artisan test tests/Feature/Notifications/PushConcurrencyMySqlTest.php
 *
 * It commits real rows (no RefreshDatabase: the workers must see them), deletes what it created afterwards and refuses to run against the
 * development database or the shared test database.
 */
class PushConcurrencyMySqlTest extends TestCase
{
    private const WORKERS = 10;

    /** @var list<int> */
    private array $userIds = [];

    protected function setUp(): void
    {
        parent::setUp();

        if (getenv('CHAT_RACE_TEST') !== '1') {
            $this->markTestSkipped('Set CHAT_RACE_TEST=1 (and DB_CONNECTION=mysql, DB_DATABASE=<dedicated database>) to run the MySQL concurrency tests.');
        }

        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            $this->markTestSkipped('The concurrency tests need MySQL / MariaDB.');
        }

        if (in_array(DB::connection()->getDatabaseName(), ['chatfeature', 'chatfeature_testing', ''], true)) {
            $this->markTestSkipped('Refusing to commit test rows into the development database; point DB_DATABASE at a dedicated one.');
        }
    }

    protected function tearDown(): void
    {
        if ($this->userIds !== []) {
            // Cascades to subscriptions, device tokens and the presence row.
            User::query()->whereIn('id', $this->userIds)->delete();
        }

        parent::tearDown();
    }

    private function agent(): User
    {
        $agent = User::factory()->agent()->create();
        $this->userIds[] = $agent->id;

        return $agent;
    }

    /**
     * @param  list<list<string>>  $jobs  worker arguments after the action
     * @return list<array<string, mixed>>
     */
    private function runWorkers(string $action, array $jobs): array
    {
        $startAt = microtime(true) + 4.0;
        $connection = (string) config('database.default');
        $environment = array_merge(getenv(), [
            'APP_ENV' => 'testing',
            'DB_CONNECTION' => $connection,
            'DB_DATABASE' => (string) DB::connection()->getDatabaseName(),
            'DB_HOST' => (string) config("database.connections.{$connection}.host"),
            'DB_PORT' => (string) config("database.connections.{$connection}.port"),
            'DB_USERNAME' => (string) config("database.connections.{$connection}.username"),
            'DB_PASSWORD' => (string) config("database.connections.{$connection}.password"),
            'BROADCAST_CONNECTION' => 'null',
            'QUEUE_CONNECTION' => 'sync',
            'CACHE_STORE' => 'array',
            'SESSION_DRIVER' => 'array',
            'PRESENCE_STORE' => 'database',
            'MAIL_MAILER' => 'array',
        ]);

        $processes = [];

        foreach ($jobs as $arguments) {
            $command = [PHP_BINARY, base_path('tests/Support/push-race-worker.php'), $action, sprintf('%.6F', $startAt), ...$arguments];
            $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, base_path(), $environment);
            $this->assertIsResource($process, 'could not start a worker');
            $processes[] = [$process, $pipes];
        }

        $results = [];

        foreach ($processes as [$process, $pipes]) {
            $out = trim((string) stream_get_contents($pipes[1]));
            $err = trim((string) stream_get_contents($pipes[2]));
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);

            $decoded = json_decode($out, true);
            $this->assertIsArray($decoded, "worker printed no JSON. stdout: {$out} stderr: {$err}");
            $results[] = $decoded;
        }

        return $results;
    }

    public function test_ten_first_registrations_of_one_endpoint_all_succeed_and_leave_one_row(): void
    {
        $agent = $this->agent();
        $endpoint = 'https://fcm.googleapis.com/fcm/send/'.Str::random(100);
        $jobs = array_fill(0, self::WORKERS, [(string) $agent->id, $endpoint]);

        $results = $this->runWorkers('subscribe', $jobs);

        $failures = array_values(array_filter($results, fn (array $result): bool => ($result['ok'] ?? false) !== true));
        $this->assertSame([], $failures, 'every registration must succeed: '.json_encode($failures));
        $this->assertSame(1, count(array_filter($results, fn (array $result): bool => ($result['created'] ?? false) === true)), 'exactly one of them created the row');
        $this->assertSame(1, PushSubscription::query()->where('user_id', $agent->id)->count());
    }

    public function test_ten_first_registrations_of_one_device_token_all_succeed_and_leave_one_row(): void
    {
        $agent = $this->agent();
        $jobs = array_fill(0, self::WORKERS, [(string) $agent->id, 'fcm-token-'.Str::random(60)]);
        // One token for all workers.
        $jobs = array_map(fn (): array => $jobs[0], $jobs);

        $results = $this->runWorkers('device', $jobs);

        $failures = array_values(array_filter($results, fn (array $result): bool => ($result['ok'] ?? false) !== true));
        $this->assertSame([], $failures, 'every registration must succeed: '.json_encode($failures));
        $this->assertSame(1, DeviceToken::query()->where('user_id', $agent->id)->count());
    }

    public function test_ten_first_presence_writes_of_one_agent_all_succeed_and_leave_one_row(): void
    {
        $agent = $this->agent();

        $results = $this->runWorkers('presence', array_fill(0, self::WORKERS, [(string) $agent->id]));

        $failures = array_values(array_filter($results, fn (array $result): bool => ($result['ok'] ?? false) !== true));
        $this->assertSame([], $failures, 'every write must succeed: '.json_encode($failures));
        $this->assertSame(1, AgentPresence::query()->where('user_id', $agent->id)->count());
    }
}
