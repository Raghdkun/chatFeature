<?php

namespace Tests\Feature\Auth;

use App\Auth\AuthModeManager;
use App\Auth\Drivers\FortifyDriver;
use App\Auth\Drivers\PizzasysDriver;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use Tests\Support\InstallStateFake;
use Tests\TestCase;

class AuthModeManagerTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_default_driver_follows_the_auth_mode_setting(): void
    {
        $manager = app(AuthModeManager::class);

        $this->assertSame('fortify', $manager->getDefaultDriver());
        $this->assertInstanceOf(FortifyDriver::class, $manager->activeDriver());
        $this->assertSame($manager->driver('fortify'), $manager->activeDriver(), 'drivers are cached per name');
    }

    public function test_before_install_it_resolves_fortify_without_touching_the_database(): void
    {
        InstallStateFake::make(installed: false);
        $queries = [];
        DB::listen(function (QueryExecuted $query) use (&$queries): void {
            $queries[] = $query->sql;
        });

        $manager = app(AuthModeManager::class);

        $this->assertSame('fortify', $manager->getDefaultDriver());
        $this->assertSame('fortify', $manager->activeDriver()->key());
        $this->assertFalse($manager->activeDriver()->capabilities()->canRegister);
        $this->assertSame([], $queries);
    }

    public function test_the_pizzasys_mode_resolves_the_pizzasys_driver(): void
    {
        settings()->set('auth.mode', 'pizzasys');

        $driver = app(AuthModeManager::class)->activeDriver();

        $this->assertInstanceOf(PizzasysDriver::class, $driver);
        $this->assertSame('pizzasys', $driver->key());
    }

    public function test_an_unknown_mode_has_no_driver(): void
    {
        $this->expectException(InvalidArgumentException::class);

        app(AuthModeManager::class)->driver('ldap');
    }
}
