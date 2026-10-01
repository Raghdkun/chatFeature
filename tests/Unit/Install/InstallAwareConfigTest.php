<?php

namespace Tests\Unit\Install;

use App\Domain\Install\InstallAwareConfig;
use App\Domain\Install\InstallState;
use App\Providers\InstallAwareConfigProvider;
use Illuminate\Config\Repository;
use Tests\TestCase;

class InstallAwareConfigTest extends TestCase
{
    /**
     * @return array<string, mixed>
     */
    private function envDrivers(): array
    {
        return [
            'install' => [
                'forced_drivers' => [
                    'session.driver' => 'file',
                    'cache.default' => 'file',
                    'queue.default' => 'sync',
                    'broadcasting.default' => 'null',
                ],
            ],
            'session' => ['driver' => 'redis'],
            'cache' => ['default' => 'redis'],
            'queue' => ['default' => 'redis'],
            'broadcasting' => ['default' => 'reverb'],
        ];
    }

    public function test_it_forces_file_sync_and_null_drivers_while_not_installed(): void
    {
        $config = new Repository($this->envDrivers());
        $state = new InstallState(sys_get_temp_dir().'/chat-no-such-dir-'.uniqid(), forcedInstalled: false);

        $forced = (new InstallAwareConfig($config, $state))->apply();

        $this->assertTrue($forced);
        $this->assertSame('file', $config->get('session.driver'));
        $this->assertSame('file', $config->get('cache.default'));
        $this->assertSame('sync', $config->get('queue.default'));
        $this->assertSame('null', $config->get('broadcasting.default'));
    }

    public function test_the_env_drivers_are_untouched_once_installed(): void
    {
        $config = new Repository($this->envDrivers());
        $state = new InstallState(sys_get_temp_dir(), forcedInstalled: true);

        $forced = (new InstallAwareConfig($config, $state))->apply();

        $this->assertFalse($forced);
        $this->assertSame('redis', $config->get('session.driver'));
        $this->assertSame('redis', $config->get('cache.default'));
        $this->assertSame('redis', $config->get('queue.default'));
        $this->assertSame('reverb', $config->get('broadcasting.default'));
    }

    public function test_the_lock_file_flips_a_fresh_instance_to_the_real_drivers(): void
    {
        $directory = sys_get_temp_dir().'/chat-lock-'.uniqid();
        mkdir($directory);

        $before = new Repository($this->envDrivers());
        (new InstallAwareConfig($before, new InstallState($directory)))->apply();
        $this->assertSame('file', $before->get('session.driver'));

        (new InstallState($directory))->writeLock();

        // The next request boots with the lock in place: `.env` drivers apply.
        $after = new Repository($this->envDrivers());
        (new InstallAwareConfig($after, new InstallState($directory)))->apply();
        $this->assertSame('redis', $after->get('session.driver'));
        $this->assertSame('reverb', $after->get('broadcasting.default'));

        @unlink($directory.'/installed.lock');
        @rmdir($directory);
    }

    public function test_restore_puts_the_original_drivers_back_and_remembers_redis_usage(): void
    {
        $config = new Repository($this->envDrivers());
        $state = new InstallState(sys_get_temp_dir(), forcedInstalled: false);
        $driverConfig = new InstallAwareConfig($config, $state);

        $driverConfig->apply();
        $this->assertSame('redis', $driverConfig->original('session.driver'));
        $this->assertTrue($driverConfig->usesRedis(), 'redis is still "in use" by the .env configuration even though it was overridden');

        $driverConfig->restore();
        $this->assertSame('redis', $config->get('session.driver'));
        $this->assertSame('reverb', $config->get('broadcasting.default'));
    }

    public function test_the_application_boots_with_the_override_provider_registered_first(): void
    {
        $providers = require base_path('bootstrap/providers.php');

        $this->assertSame(InstallAwareConfigProvider::class, $providers[0]);
    }
}
