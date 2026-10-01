<?php

namespace Tests\Feature\Install;

use App\Domain\Install\InstallAwareConfig;
use App\Domain\Install\Support\EnvironmentCheck;
use App\Domain\Install\Support\EnvironmentChecker;
use Illuminate\Support\Facades\DB;

class EnvironmentCheckerTest extends InstallTestCase
{
    /**
     * @return array<string, EnvironmentCheck>
     */
    private function checks(): array
    {
        $checks = [];
        foreach (app(EnvironmentChecker::class)->run() as $check) {
            $checks[$check->key] = $check;
        }

        return $checks;
    }

    public function test_a_healthy_environment_passes_every_check(): void
    {
        $checks = $this->checks();

        $this->assertSame(
            ['php_version', 'ext_pdo', 'ext_pdo_driver', 'ext_mbstring', 'ext_openssl', 'ext_fileinfo', 'ext_image', 'ext_intl', 'storage_writable', 'app_key', 'database', 'redis'],
            array_keys($checks),
        );
        $this->assertTrue(EnvironmentChecker::passes(array_values($checks)));
        $this->assertStringContainsString('sqlite', (string) $checks['database']->message);
        $this->assertTrue($checks['redis']->optional);
        $this->assertSame('Not used by the current configuration.', $checks['redis']->message);
    }

    public function test_a_missing_or_malformed_app_key_is_reported_with_the_fix(): void
    {
        foreach (['', 'base64:not-a-real-key', 'short'] as $key) {
            config(['app.key' => $key]);

            $check = $this->checks()['app_key'];

            $this->assertFalse($check->ok, "key [{$key}] must be rejected");
            $this->assertStringContainsString('chat:bootstrap-secrets', (string) $check->message);
        }
    }

    public function test_an_unreachable_database_gets_a_friendly_message_and_fails_the_environment(): void
    {
        $this->skipUnlessDriver('pdo_mysql');
        config([
            'database.connections.unreachable' => [
                'driver' => 'mysql', 'host' => '127.0.0.1', 'port' => '1', 'database' => 'nope', 'username' => 'nobody', 'password' => '',
                'options' => [\PDO::ATTR_TIMEOUT => 1],
            ],
            'database.default' => 'unreachable',
        ]);
        DB::purge('unreachable');

        $checks = $this->checks();

        $this->assertFalse($checks['database']->ok);
        $this->assertStringContainsString('not reachable', (string) $checks['database']->message);
        $this->assertStringContainsString('DB_HOST', (string) $checks['database']->message);
        $this->assertFalse(EnvironmentChecker::passes(array_values($checks)));
    }

    public function test_an_unusable_sqlite_file_is_reported_not_thrown(): void
    {
        config([
            'database.connections.missing' => ['driver' => 'sqlite', 'database' => '/nonexistent/dir/nope.sqlite'],
            'database.default' => 'missing',
        ]);

        $check = $this->checks()['database'];

        $this->assertFalse($check->ok);
        $this->assertStringStartsWith('Could not connect to the database', (string) $check->message);
    }

    public function test_redis_is_required_when_env_uses_it_and_reported_when_unreachable(): void
    {
        $this->skipUnlessDriver('redis');
        config([
            'session.driver' => 'redis',
            'database.redis.default' => ['host' => '127.0.0.1', 'port' => '1', 'database' => '0', 'timeout' => 1, 'read_timeout' => 1],
            'database.redis.client' => 'phpredis',
        ]);
        // Re-apply the override so the "original" drivers are remembered, as at boot.
        app(InstallAwareConfig::class)->apply();

        $check = $this->checks()['redis'];

        $this->assertFalse($check->ok);
        $this->assertFalse($check->optional);
        $this->assertStringContainsString('not reachable', (string) $check->message);
    }

    public function test_check_rows_only_include_messages_when_asked(): void
    {
        $check = new EnvironmentCheck('x', 'X', false, 'details', optional: false);

        $this->assertSame(['key' => 'x', 'label' => 'X', 'ok' => false, 'message' => 'details'], $check->toArray());
        $this->assertSame(['key' => 'x', 'label' => 'X', 'ok' => false], $check->toArray(withMessage: false));
    }

    private function skipUnlessDriver(string $extension): void
    {
        if (! extension_loaded($extension)) {
            $this->markTestSkipped("The {$extension} extension is not loaded.");
        }
    }
}
