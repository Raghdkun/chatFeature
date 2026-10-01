<?php

namespace Tests\Feature\Install;

use App\Domain\Install\InstallAwareConfig;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Session;

class DriverOverrideBootTest extends InstallTestCase
{
    public function test_a_not_installed_app_resolves_file_sync_and_null_drivers(): void
    {
        config(['session.driver' => 'redis', 'cache.default' => 'redis', 'queue.default' => 'redis', 'broadcasting.default' => 'reverb']);

        $this->assertTrue(app(InstallAwareConfig::class)->apply());

        $this->assertSame('file', Session::getDefaultDriver());
        $this->assertSame('file', Cache::getDefaultDriver());
        $this->assertSame('sync', Queue::getDefaultDriver());
        $this->assertSame('null', Broadcast::getDefaultDriver());
    }

    public function test_installing_hands_the_drivers_back_to_the_environment(): void
    {
        config(['session.driver' => 'database', 'cache.default' => 'database', 'queue.default' => 'database', 'broadcasting.default' => 'log']);
        $driverConfig = app(InstallAwareConfig::class);
        $driverConfig->apply();

        $this->install->writeLock();
        $driverConfig->restore();

        $this->assertSame('database', config('session.driver'));
        $this->assertSame('database', Cache::getDefaultDriver());
        $this->assertSame('database', Queue::getDefaultDriver());
        $this->assertSame('log', Broadcast::getDefaultDriver());
        $this->assertFalse($driverConfig->apply(), 'once the lock exists nothing is forced any more');
    }
}
